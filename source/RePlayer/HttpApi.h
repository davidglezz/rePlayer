#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace rePlayer
{
    // Snapshot built on the main thread and serialized for the HTTP clients.
    struct ApiStatus
    {
        bool hasSong = false;
        bool isPlaying = false;
        bool isPaused = false;
        bool isSeekable = false;
        bool isMuted = false;
        std::string title;
        std::string artists;
        std::string metadata;
        uint32_t timeMs = 0;
        uint32_t durationMs = 0;
        uint32_t volume = 0; // 0..100
        int32_t loopMode = 0; // 0 none, 1 playlist, 2 single
        int32_t playlistIndex = -1;
        int32_t playlistCount = 0;
    };

    // Escapes a string and returns it wrapped in double quotes.
    std::string JsonEscape(const std::string& value);

    class HttpApi
    {
    public:
        enum class CommandType : uint8_t
        {
            PlayPause,
            Next,
            Previous,
            Stop,
            SetVolume,
            SetMuted,
            ToggleMute,
            Seek,
            PlayIndex,
            SetLoop
        };

        struct Command
        {
            CommandType type = CommandType::PlayPause;
            int32_t value = 0;
        };

    public:
        static HttpApi* Create(uint16_t port, bool isLanEnabled);
        ~HttpApi();

        void Stop();

        // Main thread: publish the latest playback state (throttled internally).
        void Update(const ApiStatus& status);

        // Main thread: take the commands queued by the HTTP thread.
        void DrainCommands(std::vector<Command>& commands);

        // Main thread: true when a client asked for the playlist snapshot.
        bool ConsumePlaylistRequest();
        void SetPlaylistJson(std::string json);

    private:
        HttpApi(uint16_t port, bool isLanEnabled);

        bool Start();
        void Run();
        void HandleClient(uintptr_t client);

        void Enqueue(CommandType type, int32_t value = 0);
        std::string GetStatusJson();
        std::string GetPlaylistJson(uint32_t timeoutMs);

    private:
        uint16_t m_port;
        bool m_isLanEnabled;
        std::atomic<bool> m_isRunning = false;
        std::atomic<uintptr_t> m_listenSocket = ~uintptr_t(0);
        std::thread m_thread;

        std::mutex m_commandMutex;
        std::vector<Command> m_commands;

        std::mutex m_statusMutex;
        std::string m_statusJson = "{}";
        std::chrono::steady_clock::time_point m_lastStatusUpdate;

        std::atomic<bool> m_hasPlaylistRequest = false;
        std::mutex m_playlistMutex;
        std::condition_variable m_playlistCv;
        std::string m_playlistJson = "{}";
        uint64_t m_playlistVersion = 0;
    };
}
// namespace rePlayer
