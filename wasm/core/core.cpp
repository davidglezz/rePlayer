// rePlayer wasm core
//
// Headless decoder with a plain C ABI. Each build enables one or more engines
// (WAV/FLAC/MP3/PreTracker/Hively) and renders interleaved stereo float32 PCM
// from an in-memory buffer. No filesystem, no threads, no WASI I/O: only
// malloc/free and memcpy are used, which keeps the modules import-free.

#if defined(RP_ENGINE_ALL)
#define RP_ENGINE_WAV 1
#define RP_ENGINE_FLAC 1
#define RP_ENGINE_MP3 1
#define RP_ENGINE_PRETRACKER 1
#define RP_ENGINE_HIVELY 1
#define RP_ENGINE_XMP 1
#define RP_ENGINE_V2 1
#define RP_ENGINE_GME 1
#endif
#ifndef RP_ENGINE_WAV
#define RP_ENGINE_WAV 0
#endif
#ifndef RP_ENGINE_FLAC
#define RP_ENGINE_FLAC 0
#endif
#ifndef RP_ENGINE_MP3
#define RP_ENGINE_MP3 0
#endif
#ifndef RP_ENGINE_PRETRACKER
#define RP_ENGINE_PRETRACKER 0
#endif
#ifndef RP_ENGINE_HIVELY
#define RP_ENGINE_HIVELY 0
#endif
#ifndef RP_ENGINE_XMP
#define RP_ENGINE_XMP 0
#endif
#ifndef RP_ENGINE_V2
#define RP_ENGINE_V2 0
#endif
#ifndef RP_ENGINE_GME
#define RP_ENGINE_GME 0
#endif

#if RP_ENGINE_WAV
#define DR_WAV_NO_STDIO
#define DR_WAV_IMPLEMENTATION
#include "../../source/3rdParty/dr_libs/dr_wav.h"
#endif

#if RP_ENGINE_FLAC
#define DR_FLAC_NO_STDIO
#define DR_FLAC_IMPLEMENTATION
#include "../../source/3rdParty/dr_libs/dr_flac.h"
#endif

#if RP_ENGINE_MP3
#define DR_MP3_NO_STDIO
#define DR_MP3_IMPLEMENTATION
#include "../../source/3rdParty/dr_libs/dr_mp3.h"
#endif

#if RP_ENGINE_PRETRACKER
extern "C"
{
#include "../../source/Replays/PreTracker/pretracker/pretracker.h"
}
#endif

#if RP_ENGINE_HIVELY
extern "C"
{
#include "../../source/Replays/Hively/hvl/hvl_replay.h"
}
#endif

#if RP_ENGINE_XMP
extern "C"
{
#include "../../source/Replays/XMP/libxmp/include/xmp.h"
}
#endif

#if RP_ENGINE_V2
#include "../../source/Replays/V2/v2redux/v2redux.h"
#endif

#if RP_ENGINE_GME
#include "../../source/Replays/GME/gme/gme/gme.h"
#endif

#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace
{
    enum class Format : uint8_t
    {
        kNone = 0,
        kWav,
        kFlac,
        kMp3,
        kPreTracker,
        kHively,
        kXmp,
        kV2,
        kGme
    };

    struct RpContext
    {
        Format format = Format::kNone;
        uint8_t* data = nullptr;
        uint32_t dataSize = 0;
        uint32_t sampleRate = 0;
        uint32_t channels = 0;
        uint64_t totalFrames = 0;
        uint64_t position = 0;
        int subsongCount = 1;
        int subsong = 0;

#if RP_ENGINE_WAV
        drwav wav = {};
#endif
#if RP_ENGINE_FLAC
        drflac* flac = nullptr;
#endif
#if RP_ENGINE_MP3
        drmp3 mp3 = {};
#endif
#if RP_ENGINE_PRETRACKER
        PreSong* preTracker = nullptr;
#endif
#if RP_ENGINE_HIVELY
        hvl_tune* hively = nullptr;
        int16_t* hivelyTick = nullptr;
        uint32_t hivelyTickFrames = 0;
        uint32_t hivelyTickPos = 0;
#endif
#if RP_ENGINE_XMP
        xmp_context xmpContext = nullptr;
        const int16_t* xmpFrame = nullptr;
        uint32_t xmpFrameFrames = 0;
        uint32_t xmpFramePos = 0;
#endif
#if RP_ENGINE_V2
        v2redux::Player* v2Player = nullptr;
#endif
#if RP_ENGINE_GME
        Music_Emu* gme = nullptr;
#endif

        char title[64] = {};
        char artist[64] = {};

        float* scratch = nullptr;
        uint64_t scratchCapacity = 0; // in floats
    };

    void CloseDecoder(RpContext* ctx)
    {
#if RP_ENGINE_WAV
        if (ctx->format == Format::kWav)
            drwav_uninit(&ctx->wav);
#endif
#if RP_ENGINE_FLAC
        if (ctx->format == Format::kFlac)
        {
            if (ctx->flac)
                drflac_close(ctx->flac);
            ctx->flac = nullptr;
        }
#endif
#if RP_ENGINE_MP3
        if (ctx->format == Format::kMp3)
            drmp3_uninit(&ctx->mp3);
#endif
#if RP_ENGINE_PRETRACKER
        if (ctx->format == Format::kPreTracker)
        {
            if (ctx->preTracker)
                pre_song_destroy(ctx->preTracker);
            ctx->preTracker = nullptr;
        }
#endif
#if RP_ENGINE_HIVELY
        if (ctx->hively)
            hvl_FreeTune(ctx->hively);
        ctx->hively = nullptr;
        free(ctx->hivelyTick);
        ctx->hivelyTick = nullptr;
        ctx->hivelyTickFrames = 0;
        ctx->hivelyTickPos = 0;
#endif
#if RP_ENGINE_XMP
        if (ctx->xmpContext)
        {
            xmp_end_player(ctx->xmpContext);
            xmp_release_module(ctx->xmpContext);
            xmp_free_context(ctx->xmpContext);
            ctx->xmpContext = nullptr;
        }
        ctx->xmpFrame = nullptr;
        ctx->xmpFrameFrames = 0;
        ctx->xmpFramePos = 0;
#endif
#if RP_ENGINE_V2
        delete ctx->v2Player;
        ctx->v2Player = nullptr;
#endif
#if RP_ENGINE_GME
        if (ctx->gme)
            gme_delete(ctx->gme);
        ctx->gme = nullptr;
#endif

        ctx->format = Format::kNone;
        free(ctx->data);
        ctx->data = nullptr;
        ctx->dataSize = 0;
        ctx->sampleRate = 0;
        ctx->channels = 0;
        ctx->totalFrames = 0;
        ctx->position = 0;
        ctx->subsongCount = 1;
        ctx->subsong = 0;
        ctx->title[0] = '\0';
        ctx->artist[0] = '\0';
    }

    bool HasMagic(const uint8_t* data, uint32_t size, const char* magic, uint32_t offset)
    {
        return size >= offset + 4 && memcmp(data + offset, magic, 4) == 0;
    }

    void CopyFixedString(char* destination, size_t destinationSize, const char* source, size_t sourceSize)
    {
        size_t length = 0;
        while (length < sourceSize && source[length] != '\0')
            length++;
        if (length >= destinationSize)
            length = destinationSize - 1;
        memcpy(destination, source, length);
        destination[length] = '\0';
    }

#if RP_ENGINE_HIVELY
    bool s_hivelyInitialized = false;
#endif
}

extern "C"
{
    RpContext* rp_create()
    {
#if RP_ENGINE_HIVELY
        if (!s_hivelyInitialized)
        {
            hvl_InitReplayer();
            s_hivelyInitialized = true;
        }
#endif
        return static_cast<RpContext*>(calloc(1, sizeof(RpContext)));
    }

    void rp_destroy(RpContext* ctx)
    {
        if (!ctx)
            return;
        CloseDecoder(ctx);
        free(ctx->scratch);
        free(ctx);
    }

    int rp_load(RpContext* ctx, const uint8_t* data, uint32_t size)
    {
        if (!ctx || !data || size < 4)
            return 0;

        CloseDecoder(ctx);

        ctx->data = static_cast<uint8_t*>(malloc(size));
        if (!ctx->data)
            return 0;
        memcpy(ctx->data, data, size);
        ctx->dataSize = size;

#if RP_ENGINE_WAV
        if (HasMagic(ctx->data, size, "RIFF", 0) && HasMagic(ctx->data, size, "WAVE", 8))
        {
            if (drwav_init_memory(&ctx->wav, ctx->data, size, nullptr))
            {
                ctx->format = Format::kWav;
                ctx->sampleRate = ctx->wav.sampleRate;
                ctx->channels = ctx->wav.channels;
                ctx->totalFrames = ctx->wav.totalPCMFrameCount;
                return 1;
            }
        }
#endif

#if RP_ENGINE_FLAC
        if (HasMagic(ctx->data, size, "fLaC", 0))
        {
            ctx->flac = drflac_open_memory(ctx->data, size, nullptr);
            if (ctx->flac)
            {
                ctx->format = Format::kFlac;
                ctx->sampleRate = ctx->flac->sampleRate;
                ctx->channels = ctx->flac->channels;
                ctx->totalFrames = ctx->flac->totalPCMFrameCount;
                return 1;
            }
        }
#endif

#if RP_ENGINE_PRETRACKER
        // PreTracker: big-endian magic "PRT" + version byte.
        if (size >= 0x5A && ctx->data[0] == 'P' && ctx->data[1] == 'R' && ctx->data[2] == 'T')
        {
            ctx->preTracker = pre_song_create(ctx->data, size);
            if (ctx->preTracker)
            {
                pre_song_set_sample_rate(ctx->preTracker, 48000);
                pre_song_start(ctx->preTracker);
                // pre_song_get_length() advances the player to the end, so
                // restart it afterwards.
                int length = pre_song_get_length(ctx->preTracker);
                pre_song_start(ctx->preTracker);
                ctx->format = Format::kPreTracker;
                ctx->sampleRate = 48000;
                ctx->channels = 2;
                ctx->totalFrames = length > 0 ? static_cast<uint64_t>(length) : 0;

                if (const PreSongMetadata* metadata = pre_song_get_metadata(ctx->preTracker))
                {
                    CopyFixedString(ctx->title, sizeof(ctx->title), metadata->song_name, sizeof(metadata->song_name));
                    CopyFixedString(ctx->artist, sizeof(ctx->artist), metadata->author, sizeof(metadata->author));
                    ctx->subsongCount = metadata->num_subsongs > 0 ? metadata->num_subsongs : 1;
                }
                ctx->subsong = 0;
                return 1;
            }
        }
#endif

#if RP_ENGINE_HIVELY
        // Hively / AHX: THX or HVL magic.
        if (size >= 4
            && ((ctx->data[0] == 'T' && ctx->data[1] == 'H' && ctx->data[2] == 'X' && ctx->data[3] < 3)
                || (ctx->data[0] == 'H' && ctx->data[1] == 'V' && ctx->data[2] == 'L' && ctx->data[3] < 2)))
        {
            ctx->hively = hvl_ParseTune(ctx->data, size, 48000, 2,
                [](size_t allocSize) { return calloc(1, allocSize); },
                [](void* ptr) { free(ptr); });
            if (ctx->hively)
            {
                ctx->format = Format::kHively;
                ctx->sampleRate = 48000;
                ctx->channels = 2;
                ctx->totalFrames = static_cast<uint64_t>(hvl_GetDuration(ctx->hively)) * 48000 / 1000;
                ctx->subsongCount = ctx->hively->ht_SubsongNr > 0 ? ctx->hively->ht_SubsongNr : 1;
                ctx->subsong = 0;

                // hvl_Decode advances one 50 Hz tick regardless of how many
                // samples it is given, so buffer whole ticks instead of
                // handing it the render block size.
                uint32_t speed = ctx->hively->ht_SpeedMultiplier;
                if (speed == 0)
                    speed = 1;
                ctx->hivelyTickFrames = 48000u / 50u / speed;
                if (ctx->hivelyTickFrames == 0)
                    ctx->hivelyTickFrames = 1;
                ctx->hivelyTick = static_cast<int16_t*>(calloc(ctx->hivelyTickFrames * 2, sizeof(int16_t)));
                ctx->hivelyTickPos = ctx->hivelyTickFrames;
                if (!ctx->hivelyTick)
                {
                    hvl_FreeTune(ctx->hively);
                    ctx->hively = nullptr;
                    ctx->format = Format::kNone;
                    return 0;
                }

                // hvl_GetDuration plays the tune to its end; rewind it.
                hvl_InitSubsong(ctx->hively, 0);

                CopyFixedString(ctx->title, sizeof(ctx->title), ctx->hively->ht_Name, sizeof(ctx->hively->ht_Name));
                return 1;
            }
        }
#endif

#if RP_ENGINE_MP3
        // MP3: let dr_mp3 scan for a valid frame (it also handles ID3 tags).
        if (drmp3_init_memory(&ctx->mp3, ctx->data, size, nullptr))
        {
            ctx->format = Format::kMp3;
            ctx->sampleRate = ctx->mp3.sampleRate;
            ctx->channels = ctx->mp3.channels;
            ctx->totalFrames = drmp3_get_pcm_frame_count(&ctx->mp3);
            return 1;
        }
#endif

#if RP_ENGINE_V2
        // V2M: the two bytes after the version word are always zero.
        if (size >= 16 && ctx->data[2] == 0 && ctx->data[3] == 0)
        {
            auto* player = new v2redux::Player();
            if (player->open(ctx->data, size, v2redux::Era::Auto()) == v2redux::Result::OK)
            {
                long long lengthMs = player->lengthMs();
                player->play(0);
                ctx->v2Player = player;
                ctx->format = Format::kV2;
                ctx->sampleRate = 44100;
                ctx->channels = 2;
                ctx->totalFrames = static_cast<uint64_t>(lengthMs) * 44100 / 1000;
                ctx->subsongCount = 1;
                ctx->subsong = 0;
                return 1;
            }
            delete player;
        }
#endif

#if RP_ENGINE_XMP
        // XMP is the catch-all tracker engine: MOD/XM/IT/S3M and many more.
        // Keep it after the dedicated decoders so it cannot claim those files.
        if (size >= 16)
        {
            xmp_context xmp = xmp_create_context();
            if (xmp && xmp_load_module_from_memory(xmp, ctx->data, static_cast<long>(size)) == 0)
            {
                xmp_module_info info = {};
                xmp_get_module_info(xmp, &info);
                if (info.mod && info.num_sequences > 0
                    && xmp_start_player(xmp, 48000, 0) == 0)
                {
                    xmp_set_position(xmp, info.seq_data[0].entry_point);
                    ctx->xmpContext = xmp;
                    ctx->format = Format::kXmp;
                    ctx->sampleRate = 48000;
                    ctx->channels = 2;
                    ctx->subsongCount = info.num_sequences;
                    ctx->subsong = 0;
                    ctx->totalFrames = static_cast<uint64_t>(info.seq_data[0].duration) * 48000 / 1000;
                    ctx->xmpFrame = nullptr;
                    ctx->xmpFrameFrames = 0;
                    ctx->xmpFramePos = 0;
                    CopyFixedString(ctx->title, sizeof(ctx->title), info.mod->name, sizeof(info.mod->name));
                    return 1;
                }
                xmp_release_module(xmp);
            }
            if (xmp)
                xmp_free_context(xmp);
        }
#endif

#if RP_ENGINE_GME
        // Game Music Emu: NSF/NSFE/GBS/VGM/VGZ/SPC/HES/KSS/AY/SAP/GYM.
        if (size >= 4)
        {
            Music_Emu* emu = nullptr;
            if (gme_open_data(ctx->data, static_cast<long>(size), &emu, 48000) == nullptr && emu)
            {
                gme_set_stereo_depth(emu, 1.0);
                gme_ignore_silence(emu, 1);
                int trackCount = gme_track_count(emu);
                if (trackCount > 0 && gme_start_track(emu, 0) == nullptr)
                {
                    int lengthMs = 150000;
                    gme_info_t* info = nullptr;
                    if (gme_track_info(emu, &info, 0) == nullptr && info)
                    {
                        if (info->play_length > 0)
                            lengthMs = info->play_length;
                        if (info->song[0])
                            CopyFixedString(ctx->title, sizeof(ctx->title), info->song, 256);
                        else if (info->game[0])
                            CopyFixedString(ctx->title, sizeof(ctx->title), info->game, 256);
                        if (info->author[0])
                            CopyFixedString(ctx->artist, sizeof(ctx->artist), info->author, 256);
                        gme_free_info(info);
                    }
                    ctx->gme = emu;
                    ctx->format = Format::kGme;
                    ctx->sampleRate = 48000;
                    ctx->channels = 2;
                    ctx->totalFrames = static_cast<uint64_t>(lengthMs) * 48000 / 1000;
                    ctx->subsongCount = trackCount;
                    ctx->subsong = 0;
                    return 1;
                }
                gme_delete(emu);
            }
        }
#endif

        free(ctx->data);
        ctx->data = nullptr;
        ctx->dataSize = 0;
        return 0;
    }

    uint32_t rp_sample_rate(RpContext* ctx)
    {
        return ctx ? ctx->sampleRate : 0;
    }

    uint32_t rp_channels(RpContext* ctx)
    {
        return ctx ? ctx->channels : 0;
    }

    uint64_t rp_frames(RpContext* ctx)
    {
        return ctx ? ctx->totalFrames : 0;
    }

    uint64_t rp_position(RpContext* ctx)
    {
        return ctx ? ctx->position : 0;
    }

    int rp_is_loaded(RpContext* ctx)
    {
        return ctx && ctx->format != Format::kNone;
    }

    // 0: none, 1: WAV, 2: FLAC, 3: MP3, 4: PreTracker, 5: Hively.
    int rp_format(RpContext* ctx)
    {
        return ctx ? static_cast<int>(ctx->format) : 0;
    }

    const char* rp_title(RpContext* ctx)
    {
        return ctx ? ctx->title : "";
    }

    const char* rp_artist(RpContext* ctx)
    {
        return ctx ? ctx->artist : "";
    }

    int rp_subsong_count(RpContext* ctx)
    {
        return ctx ? ctx->subsongCount : 0;
    }

    int rp_subsong(RpContext* ctx)
    {
        return ctx ? ctx->subsong : 0;
    }

    int rp_set_subsong(RpContext* ctx, int index)
    {
        if (!ctx || index < 0 || index >= ctx->subsongCount)
            return 0;

#if RP_ENGINE_HIVELY
        if (ctx->format == Format::kHively)
        {
            if (!hvl_InitSubsong(ctx->hively, index))
                return 0;
            ctx->subsong = index;
            ctx->totalFrames = static_cast<uint64_t>(hvl_GetDuration(ctx->hively)) * 48000 / 1000;
            hvl_InitSubsong(ctx->hively, index);
            ctx->position = 0;
            ctx->hivelyTickPos = ctx->hivelyTickFrames;
            return 1;
        }
#endif

#if RP_ENGINE_PRETRACKER
        if (ctx->format == Format::kPreTracker)
        {
            pre_song_set_subsong(ctx->preTracker, index);
            pre_song_start(ctx->preTracker);
            // As above, querying the length advances the player.
            int length = pre_song_get_length(ctx->preTracker);
            pre_song_start(ctx->preTracker);

            ctx->subsong = index;
            ctx->totalFrames = length > 0 ? static_cast<uint64_t>(length) : 0;
            ctx->position = 0;
            return 1;
        }
#endif

#if RP_ENGINE_XMP
        if (ctx->format == Format::kXmp)
        {
            xmp_module_info info = {};
            xmp_get_module_info(ctx->xmpContext, &info);
            if (!info.mod || index >= info.num_sequences)
                return 0;
            if (xmp_start_player(ctx->xmpContext, 48000, 0) != 0)
                return 0;
            xmp_set_position(ctx->xmpContext, info.seq_data[index].entry_point);
            ctx->subsong = index;
            ctx->totalFrames = static_cast<uint64_t>(info.seq_data[index].duration) * 48000 / 1000;
            ctx->position = 0;
            ctx->xmpFrame = nullptr;
            ctx->xmpFrameFrames = 0;
            ctx->xmpFramePos = 0;
            return 1;
        }
#endif

#if RP_ENGINE_V2
        if (ctx->format == Format::kV2)
        {
            ctx->v2Player->play(0);
            ctx->position = 0;
            return index == 0;
        }
#endif

#if RP_ENGINE_GME
        if (ctx->format == Format::kGme)
        {
            if (index < 0 || index >= ctx->subsongCount)
                return 0;
            if (gme_start_track(ctx->gme, index) != nullptr)
                return 0;
            ctx->subsong = index;
            ctx->position = 0;
            int lengthMs = 150000;
            gme_info_t* info = nullptr;
            if (gme_track_info(ctx->gme, &info, index) == nullptr && info)
            {
                if (info->play_length > 0)
                    lengthMs = info->play_length;
                if (info->song[0])
                    CopyFixedString(ctx->title, sizeof(ctx->title), info->song, 256);
                else if (info->game[0])
                    CopyFixedString(ctx->title, sizeof(ctx->title), info->game, 256);
                if (info->author[0])
                    CopyFixedString(ctx->artist, sizeof(ctx->artist), info->author, 256);
                gme_free_info(info);
            }
            ctx->totalFrames = static_cast<uint64_t>(lengthMs) * 48000 / 1000;
            return 1;
        }
#endif

        return 0;
    }

    int rp_seek(RpContext* ctx, uint64_t frame)
    {
        if (!ctx)
            return 0;

        int ok = 0;
        switch (ctx->format)
        {
#if RP_ENGINE_WAV
        case Format::kWav:
            ok = drwav_seek_to_pcm_frame(&ctx->wav, frame) != 0;
            break;
#endif
#if RP_ENGINE_FLAC
        case Format::kFlac:
            ok = drflac_seek_to_pcm_frame(ctx->flac, frame) != 0;
            break;
#endif
#if RP_ENGINE_MP3
        case Format::kMp3:
            ok = drmp3_seek_to_pcm_frame(&ctx->mp3, frame) != 0;
            break;
#endif
#if RP_ENGINE_PRETRACKER
        case Format::kPreTracker:
        {
            // PreTracker has no native seek: restart and discard frames.
            pre_song_start(ctx->preTracker);

            const uint32_t chunk = 2048;
            const uint64_t needed = static_cast<uint64_t>(chunk) * 2;
            if (needed > ctx->scratchCapacity)
            {
                auto* scratch = static_cast<float*>(realloc(ctx->scratch, static_cast<size_t>(needed) * sizeof(float)));
                if (!scratch)
                    return 0;
                ctx->scratch = scratch;
                ctx->scratchCapacity = needed;
            }

            uint64_t remaining = frame;
            while (remaining > 0)
            {
                uint32_t count = remaining < chunk ? static_cast<uint32_t>(remaining) : chunk;
                int got = pre_song_decode(ctx->preTracker, ctx->scratch, static_cast<int>(count));
                if (got <= 0)
                    break;
                remaining -= static_cast<uint64_t>(got);
            }
            ctx->position = frame - remaining;
            return 1;
        }
#endif
#if RP_ENGINE_HIVELY
        case Format::kHively:
        {
            uint32_t ms = static_cast<uint32_t>(frame * 1000 / 48000);
            uint32_t actual = hvl_Seek(ctx->hively, ms);
            ctx->position = static_cast<uint64_t>(actual) * 48000 / 1000;
            ctx->hivelyTickPos = ctx->hivelyTickFrames;
            return 1;
        }
#endif
#if RP_ENGINE_XMP
        case Format::kXmp:
        {
            uint32_t ms = static_cast<uint32_t>(frame * 1000 / 48000);
            if (xmp_seek_time(ctx->xmpContext, static_cast<int>(ms)) < 0)
            {
                xmp_start_player(ctx->xmpContext, 48000, 0);
                xmp_set_position(ctx->xmpContext, 0);
            }
            // xmp_seek_time lands on a pattern boundary; advance frame by
            // frame until the reported time reaches the requested position.
            xmp_frame_info info;
            for (int guard = 0; guard < 1000000; ++guard)
            {
                xmp_get_frame_info(ctx->xmpContext, &info);
                if (info.time >= static_cast<int>(ms))
                    break;
                if (xmp_play_frame(ctx->xmpContext) != 0)
                    break;
            }
            ctx->position = frame < ctx->totalFrames ? frame : ctx->totalFrames;
            ctx->xmpFrame = nullptr;
            ctx->xmpFrameFrames = 0;
            ctx->xmpFramePos = 0;
            return 1;
        }
#endif
#if RP_ENGINE_V2
        case Format::kV2:
        {
            uint32_t ms = static_cast<uint32_t>(frame * 1000 / 44100);
            ctx->v2Player->play(ms);
            ctx->position = frame < ctx->totalFrames ? frame : ctx->totalFrames;
            return 1;
        }
#endif
#if RP_ENGINE_GME
        case Format::kGme:
        {
            uint32_t ms = static_cast<uint32_t>(frame * 1000 / 48000);
            if (gme_seek(ctx->gme, static_cast<int>(ms)) != nullptr)
                return 0;
            ctx->position = frame < ctx->totalFrames ? frame : ctx->totalFrames;
            return 1;
        }
#endif
        default:
            break;
        }

        if (ok)
            ctx->position = frame;
        return ok;
    }

    // Renders up to `frames` stereo frames into `out` (interleaved L/R float32).
    // Returns the number of frames actually decoded (0 means end of stream).
    uint32_t rp_render(RpContext* ctx, float* out, uint32_t frames)
    {
        if (!ctx || !out || frames == 0 || ctx->format == Format::kNone)
            return 0;

        const uint32_t channels = ctx->channels ? ctx->channels : 2;
        const uint64_t needed = static_cast<uint64_t>(frames) * channels;
        if (needed > ctx->scratchCapacity)
        {
            auto* scratch = static_cast<float*>(realloc(ctx->scratch, static_cast<size_t>(needed) * sizeof(float)));
            if (!scratch)
                return 0;
            ctx->scratch = scratch;
            ctx->scratchCapacity = needed;
        }

        uint64_t read = 0;
        switch (ctx->format)
        {
#if RP_ENGINE_WAV
        case Format::kWav:
            read = drwav_read_pcm_frames_f32(&ctx->wav, frames, ctx->scratch);
            break;
#endif
#if RP_ENGINE_FLAC
        case Format::kFlac:
            read = drflac_read_pcm_frames_f32(ctx->flac, frames, ctx->scratch);
            break;
#endif
#if RP_ENGINE_MP3
        case Format::kMp3:
            read = drmp3_read_pcm_frames_f32(&ctx->mp3, frames, ctx->scratch);
            break;
#endif
#if RP_ENGINE_PRETRACKER
        case Format::kPreTracker:
        {
            int got = pre_song_decode(ctx->preTracker, ctx->scratch, static_cast<int>(frames));
            read = got > 0 ? static_cast<uint64_t>(got) : 0;
            break;
        }
#endif
#if RP_ENGINE_HIVELY
        case Format::kHively:
        {
            uint64_t remaining = ctx->totalFrames > ctx->position ? ctx->totalFrames - ctx->position : 0;
            uint32_t count = remaining < frames ? static_cast<uint32_t>(remaining) : frames;
            uint32_t done = 0;
            while (done < count)
            {
                if (ctx->hivelyTickPos >= ctx->hivelyTickFrames)
                {
                    hvl_Decode(ctx->hively, ctx->hivelyTick, ctx->hivelyTickFrames);
                    ctx->hivelyTickPos = 0;
                }
                uint32_t available = ctx->hivelyTickFrames - ctx->hivelyTickPos;
                uint32_t chunk = count - done < available ? count - done : available;
                for (uint32_t i = 0; i < chunk; i++)
                {
                    uint32_t src = (ctx->hivelyTickPos + i) * 2;
                    uint32_t dst = (done + i) * 2;
                    out[dst + 0] = ctx->hivelyTick[src + 0] / 32767.0f;
                    out[dst + 1] = ctx->hivelyTick[src + 1] / 32767.0f;
                }
                done += chunk;
                ctx->hivelyTickPos += chunk;
            }
            for (uint32_t i = count; i < frames; i++)
            {
                out[i * 2 + 0] = 0.0f;
                out[i * 2 + 1] = 0.0f;
            }
            ctx->position += count;
            return count;
        }
#endif
#if RP_ENGINE_XMP
        case Format::kXmp:
        {
            uint64_t remaining = ctx->totalFrames > ctx->position ? ctx->totalFrames - ctx->position : 0;
            uint32_t count = remaining < frames ? static_cast<uint32_t>(remaining) : frames;
            uint32_t done = 0;
            while (done < count)
            {
                if (ctx->xmpFramePos >= ctx->xmpFrameFrames)
                {
                    if (xmp_play_frame(ctx->xmpContext) != 0)
                        break;
                    xmp_frame_info info;
                    xmp_get_frame_info(ctx->xmpContext, &info);
                    if (!info.buffer || info.buffer_size <= 0)
                        break;
                    ctx->xmpFrame = static_cast<const int16_t*>(info.buffer);
                    ctx->xmpFrameFrames = static_cast<uint32_t>(info.buffer_size) / 4;
                    ctx->xmpFramePos = 0;
                }
                uint32_t available = ctx->xmpFrameFrames - ctx->xmpFramePos;
                uint32_t chunk = count - done < available ? count - done : available;
                const int16_t* src = ctx->xmpFrame + ctx->xmpFramePos * 2;
                for (uint32_t i = 0; i < chunk; i++)
                {
                    uint32_t dst = (done + i) * 2;
                    out[dst + 0] = src[i * 2 + 0] / 32768.0f;
                    out[dst + 1] = src[i * 2 + 1] / 32768.0f;
                }
                done += chunk;
                ctx->xmpFramePos += chunk;
            }
            for (uint32_t i = count; i < frames; i++)
            {
                out[i * 2 + 0] = 0.0f;
                out[i * 2 + 1] = 0.0f;
            }
            ctx->position += count;
            return count;
        }
#endif
#if RP_ENGINE_V2
        case Format::kV2:
        {
            uint64_t remaining = ctx->totalFrames > ctx->position ? ctx->totalFrames - ctx->position : 0;
            uint32_t count = remaining < frames ? static_cast<uint32_t>(remaining) : frames;
            if (count > 0)
                ctx->v2Player->render(out, count);
            for (uint32_t i = count; i < frames; i++)
            {
                out[i * 2 + 0] = 0.0f;
                out[i * 2 + 1] = 0.0f;
            }
            ctx->position += count;
            return count;
        }
#endif
#if RP_ENGINE_GME
        case Format::kGme:
        {
            uint64_t remaining = ctx->totalFrames > ctx->position ? ctx->totalFrames - ctx->position : 0;
            uint32_t count = remaining < frames ? static_cast<uint32_t>(remaining) : frames;
            if (count > 0 && gme_track_ended(ctx->gme) == 0)
            {
                auto* pcm = reinterpret_cast<int16_t*>(ctx->scratch);
                if (gme_play(ctx->gme, static_cast<int>(count) * 2, pcm) == nullptr)
                {
                    for (uint32_t i = 0; i < count; i++)
                    {
                        out[i * 2 + 0] = pcm[i * 2 + 0] / 32768.0f;
                        out[i * 2 + 1] = pcm[i * 2 + 1] / 32768.0f;
                    }
                }
                else
                {
                    for (uint32_t i = 0; i < count; i++)
                    {
                        out[i * 2 + 0] = 0.0f;
                        out[i * 2 + 1] = 0.0f;
                    }
                }
            }
            else
            {
                for (uint32_t i = 0; i < count; i++)
                {
                    out[i * 2 + 0] = 0.0f;
                    out[i * 2 + 1] = 0.0f;
                }
            }
            for (uint32_t i = count; i < frames; i++)
            {
                out[i * 2 + 0] = 0.0f;
                out[i * 2 + 1] = 0.0f;
            }
            ctx->position += count;
            return count;
        }
#endif
        default:
            return 0;
        }

        if (read > frames)
            read = frames;

        for (uint64_t i = 0; i < read; i++)
        {
            if (channels == 1)
            {
                out[i * 2 + 0] = ctx->scratch[i];
                out[i * 2 + 1] = ctx->scratch[i];
            }
            else
            {
                out[i * 2 + 0] = ctx->scratch[i * channels + 0];
                out[i * 2 + 1] = ctx->scratch[i * channels + 1];
            }
        }
        for (uint64_t i = read; i < frames; i++)
        {
            out[i * 2 + 0] = 0.0f;
            out[i * 2 + 1] = 0.0f;
        }

        ctx->position += read;
        return static_cast<uint32_t>(read);
    }
}
