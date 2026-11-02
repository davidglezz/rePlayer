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
        kHively
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
