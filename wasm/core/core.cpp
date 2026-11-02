// rePlayer wasm core
//
// Headless decoder with a plain C ABI. It decodes WAV (dr_wav), FLAC (dr_flac)
// and MP3 (dr_mp3) from an in-memory buffer and renders interleaved stereo
// float32 PCM. No filesystem, no threads, no WASI I/O: only malloc/free and
// memcpy are used, which keeps the module import-free for the browser.

#define DR_WAV_NO_STDIO
#define DR_FLAC_NO_STDIO
#define DR_MP3_NO_STDIO

#define DR_WAV_IMPLEMENTATION
#define DR_FLAC_IMPLEMENTATION
#define DR_MP3_IMPLEMENTATION

#include "../../source/3rdParty/dr_libs/dr_wav.h"
#include "../../source/3rdParty/dr_libs/dr_flac.h"
#include "../../source/3rdParty/dr_libs/dr_mp3.h"

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
        kMp3
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

        drwav wav = {};
        drmp3 mp3 = {};
        drflac* flac = nullptr;

        float* scratch = nullptr;
        uint64_t scratchCapacity = 0; // in floats
    };

    void CloseDecoder(RpContext* ctx)
    {
        if (ctx->format == Format::kWav)
            drwav_uninit(&ctx->wav);
        else if (ctx->format == Format::kFlac)
        {
            if (ctx->flac)
                drflac_close(ctx->flac);
            ctx->flac = nullptr;
        }
        else if (ctx->format == Format::kMp3)
            drmp3_uninit(&ctx->mp3);

        ctx->format = Format::kNone;
        free(ctx->data);
        ctx->data = nullptr;
        ctx->dataSize = 0;
        ctx->sampleRate = 0;
        ctx->channels = 0;
        ctx->totalFrames = 0;
        ctx->position = 0;
    }

    bool HasMagic(const uint8_t* data, uint32_t size, const char* magic, uint32_t offset)
    {
        return size >= offset + 4 && memcmp(data + offset, magic, 4) == 0;
    }
}

extern "C"
{
    RpContext* rp_create()
    {
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

        // MP3: let dr_mp3 scan for a valid frame (it also handles ID3 tags).
        if (drmp3_init_memory(&ctx->mp3, ctx->data, size, nullptr))
        {
            ctx->format = Format::kMp3;
            ctx->sampleRate = ctx->mp3.sampleRate;
            ctx->channels = ctx->mp3.channels;
            ctx->totalFrames = drmp3_get_pcm_frame_count(&ctx->mp3);
            return 1;
        }

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

    // 0: none, 1: WAV, 2: FLAC, 3: MP3.
    int rp_format(RpContext* ctx)
    {
        return ctx ? static_cast<int>(ctx->format) : 0;
    }

    int rp_seek(RpContext* ctx, uint64_t frame)
    {
        if (!ctx)
            return 0;

        int ok = 0;
        switch (ctx->format)
        {
        case Format::kWav:
            ok = drwav_seek_to_pcm_frame(&ctx->wav, frame) != 0;
            break;
        case Format::kFlac:
            ok = drflac_seek_to_pcm_frame(ctx->flac, frame) != 0;
            break;
        case Format::kMp3:
            ok = drmp3_seek_to_pcm_frame(&ctx->mp3, frame) != 0;
            break;
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
        case Format::kWav:
            read = drwav_read_pcm_frames_f32(&ctx->wav, frames, ctx->scratch);
            break;
        case Format::kFlac:
            read = drflac_read_pcm_frames_f32(ctx->flac, frames, ctx->scratch);
            break;
        case Format::kMp3:
            read = drmp3_read_pcm_frames_f32(&ctx->mp3, frames, ctx->scratch);
            break;
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
