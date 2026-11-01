// Core
#include <Core/Log.h>
#include <Core/Thread/Workers.h>

// rePlayer
#include <Database/SongEditor.h>
#include <Deck/Deck.h>
#include <Deck/Player.h>
#include <Library/Library.h>
#include <Library/LibraryDatabase.h>
#include <Playlist/Playlist.h>
#include <Playlist/PlaylistDatabase.h>
#include <RePlayer/About.h>
#include <RePlayer/Replays.h>
#include <RePlayer/Settings.h>

// curl
#include <curl/curl.h>
#pragma comment(lib, "Crypt32.lib")
#pragma comment(lib, "Secur32.lib")
#pragma comment(lib, "Ws2_32.Lib")

// stl
#include <atomic>
#include <csignal>
#include <cstdlib>
#include <cstring>

#include "Core.h"

namespace rePlayer
{
    namespace
    {
        std::string GetEnv(const char* name)
        {
            char* value = nullptr;
            size_t length = 0;
            if (_dupenv_s(&value, &length, name) != 0 || value == nullptr)
                return {};
            std::string result(value);
            free(value);
            return result;
        }

        ApiStatus BuildApiStatus(Deck& deck, Playlist& playlist)
        {
            ApiStatus status;
            if (Player* player = deck.GetCurrentPlayer())
            {
                status.hasSong = true;
                status.isPlaying = player->IsPlaying();
                status.isPaused = !player->IsPlaying() && !player->IsStopped();
                status.isSeekable = player->IsSeekable();
                status.title = player->GetTitle();
                status.artists = player->GetArtists();
                status.metadata = player->GetMetadata();
                status.timeMs = player->GetPlaybackTimeInMs();
                status.durationMs = player->GetSubsong().durationCs * 10u;
                if (status.durationMs < status.timeMs)
                    status.durationMs = status.timeMs;
            }
            status.isMuted = deck.IsMuted();
            status.volume = (deck.GetVolume() * 100 + 32767) / 65535;
            status.loopMode = deck.GetLoopMode();
            status.playlistIndex = playlist.GetCurrentEntryIndex();
            status.playlistCount = static_cast<int32_t>(playlist.NumEntries());
            return status;
        }

        std::string BuildPlaylistJson(Playlist& playlist)
        {
            auto count = playlist.NumEntries();
            std::string json;
            json.reserve(128 + count * 96);
            json += "{\"current\":";
            json += std::to_string(playlist.GetCurrentEntryIndex());
            json += ",\"count\":";
            json += std::to_string(count);
            json += ",\"entries\":[";
            for (uint32_t i = 0; i < count; i++)
            {
                if (i)
                    json += ',';
                auto musicId = playlist.GetEntry(i);
                json += "{\"index\":";
                json += std::to_string(i);
                if (musicId.IsValid())
                {
                    json += ",\"title\":";
                    json += JsonEscape(musicId.GetTitle());
                    json += ",\"artists\":";
                    json += JsonEscape(musicId.GetArtists());
                }
                else
                    json += ",\"title\":\"(unavailable)\",\"artists\":\"\"";
                json += '}';
            }
            json += "]}";
            return json;
        }
    }

    RePlayer* Core::Create()
    {
        if (ms_instance)
            return nullptr;

        curl_global_init_mem(CURL_GLOBAL_DEFAULT
            , [](size_t size) { return core::Alloc(size); }
        , [](void* ptr) { core::Free(ptr); }
        , [](void* ptr, size_t size) { return core::Realloc(ptr, size); }
        , [](const char* str) { char* ptr = nullptr; if (str) { auto size = strlen(str); ptr = core::Alloc<char>(size + 1); memcpy(ptr, str, size + 1); } return ptr; }
        , [](size_t nmemb, size_t size) { void* ptr = core::Alloc(nmemb * size); memset(ptr, 0, nmemb * size); return ptr; });

        if (CheckForNewVersion() == Status::kOk)
            ms_instance = new Core();
        else
            curl_global_cleanup();

        struct
        {
            static LONG WINAPI TopLevelExceptionFilter(EXCEPTION_POINTERS* e)
            {
                if (ms_instance)
                {
                    static std::atomic<int32_t> isLock = 0;
                    if (isLock.exchange(1) == 0)
                    {
                        Log::Error("CRASH: %08X\n", e->ExceptionRecord->ExceptionCode);
                        ms_instance->m_library->Save();
                        ms_instance->m_playlist->Save();
                    }
                }
                return EXCEPTION_CONTINUE_SEARCH;
            }
            static void OnAbort(int)
            {
                EXCEPTION_RECORD r = {
                    .ExceptionCode = 0xBAADC0DE
                };
                EXCEPTION_POINTERS e = {
                    .ExceptionRecord = &r
                };
                TopLevelExceptionFilter(&e);
                _exit(1); // avoid recursion
            }
        } cb;
        ::SetUnhandledExceptionFilter(&cb.TopLevelExceptionFilter);
        std::signal(SIGABRT, &cb.OnAbort);

        return ms_instance;
    }

    Core::~Core()
    {
        if (m_httpApi)
        {
            m_httpApi->Stop();
            delete m_httpApi;
            m_httpApi = nullptr;
        }

        m_playlist->Flush();
        m_workers->Flush();
        m_library->Validate();
        m_library->Save();
        m_playlist->Save();

        delete m_deck;
        delete m_settings;
        delete m_replays;
        delete m_songEditor;
        delete m_library;
        delete m_playlist;
        delete m_about;
        for (auto* db : m_db)
            delete db;

        delete m_workers;

        while (m_songsStack.items)
        {
            auto* next = m_songsStack.items->next;
            delete m_songsStack.items;
            m_songsStack.items = next;
        }
        while (m_artistsStack.items)
        {
            auto* next = m_artistsStack.items->next;
            delete m_artistsStack.items;
            m_artistsStack.items = next;
        }
    }

    void Core::Release()
    {
        if (ms_instance)
        {
            delete this;

            curl_global_cleanup();

            ms_instance = nullptr;
        }
    }

    Status Core::Launch()
    {
        if (m_deck == nullptr)
        {
            m_workers = new thread::Workers(8, 16, L"rePlayer");

            m_libraryDatabase = new LibraryDatabase();
            m_playlistDatabase = new PlaylistDatabase();
            assert(m_db[int32_t(DatabaseID::kLibrary)] == m_libraryDatabase);
            assert(m_db[int32_t(DatabaseID::kPlaylist)] == m_playlistDatabase);
            m_deck = new Deck();
            m_settings = new Settings();
            m_replays = new Replays();
            m_songEditor = new SongEditor();
            m_library = new Library();
            m_playlist = new Playlist();
            m_about = new About();

            auto portValue = GetEnv("REPLAYER_HTTP_PORT");
            uint16_t port = 8080;
            if (!portValue.empty())
            {
                auto value = std::atoi(portValue.c_str());
                port = (value > 0 && value < 65536) ? static_cast<uint16_t>(value) : 0;
            }

            auto hostValue = GetEnv("REPLAYER_HTTP_HOST");
            bool isLanEnabled = hostValue == "0.0.0.0" || hostValue == "any";

            if (port)
            {
                m_httpApi = HttpApi::Create(port, isLanEnabled);
                if (m_httpApi)
                    Log::Message("HTTP API listening on http://%s:%u/\n", isLanEnabled ? "0.0.0.0" : "127.0.0.1", port);
                else
                    Log::Error("HTTP API: failed to listen on port %u\n", port);
            }
        }

        return Status::kOk;
    }

    Status Core::UpdateFrame()
    {
        m_workers->Update();

        Reconcile();

        if (m_httpApi)
        {
            m_httpApi->DrainCommands(m_httpCommands);
            for (auto& command : m_httpCommands)
                ExecuteHttpCommand(command);
            m_httpCommands.clear();
        }

        auto status =  m_deck->UpdateFrame();

        for (auto* db : m_db)
            db->Update();

        if (m_httpApi)
        {
            if (m_httpApi->ConsumePlaylistRequest())
                m_httpApi->SetPlaylistJson(BuildPlaylistJson(*m_playlist));
            m_httpApi->Update(BuildApiStatus(*m_deck, *m_playlist));
        }

        return status;
    }

    void Core::ExecuteHttpCommand(const HttpApi::Command& command)
    {
        switch (command.type)
        {
        case HttpApi::CommandType::PlayPause:
            m_deck->PlayPause();
            break;
        case HttpApi::CommandType::Next:
            m_deck->Next();
            break;
        case HttpApi::CommandType::Previous:
            m_deck->Previous();
            break;
        case HttpApi::CommandType::Stop:
            m_deck->Stop();
            break;
        case HttpApi::CommandType::SetVolume:
            m_deck->SetVolume(static_cast<uint32_t>(Clamp(command.value, 0, 65535)));
            break;
        case HttpApi::CommandType::SetMuted:
            m_deck->SetMuted(command.value != 0);
            break;
        case HttpApi::CommandType::ToggleMute:
            m_deck->MuteVolume();
            break;
        case HttpApi::CommandType::Seek:
            m_deck->Seek(command.value > 0 ? static_cast<uint32_t>(command.value) : 0);
            break;
        case HttpApi::CommandType::PlayIndex:
            m_playlist->PlayEntry(command.value);
            break;
        case HttpApi::CommandType::SetLoop:
            m_deck->SetLoopMode(command.value);
            break;
        default:
            break;
        }
    }

    void Core::Enable(bool isEnabled)
    {
        m_deck->Enable(isEnabled);
    }

    float Core::GetBlendingFactor() const
    {
        return m_deck->GetBlendingFactor();
    }

    void Core::PlayPause()
    {
        m_deck->PlayPause();
    }

    void Core::Next()
    {
        m_deck->Next();
    }

    void Core::Previous()
    {
        m_deck->Previous();
    }

    void Core::Stop()
    {
        m_deck->Stop();
    }

    void Core::IncreaseVolume()
    {
        m_deck->IncreaseVolume();
    }

    void Core::DecreaseVolume()
    {
        m_deck->DecreaseVolume();
    }

    void Core::MuteVolume()
    {
        m_deck->MuteVolume();
    }

    void Core::Discard()
    {
        m_deck->Discard();
    }

    void Core::SystrayMouseLeft(int32_t x, int32_t y)
    {
        m_deck->OnSystray(x, y, Deck::SystrayState::kMouseButtonLeft);
    }

    void Core::SystrayMouseMiddle(int32_t x, int32_t y)
    {
        m_deck->OnSystray(x, y, Deck::SystrayState::kMouseButtonMiddle);
    }

    void Core::SystrayMouseRight(int32_t x, int32_t y)
    {
        m_deck->OnSystray(x, y, Deck::SystrayState::kMouseButtonRight);
    }

    void Core::SystrayTooltipOpen(int32_t x, int32_t y)
    {
        m_deck->OnSystray(x, y, Deck::SystrayState::kTooltipOpen);
    }

    void Core::SystrayTooltipClose(int32_t x, int32_t y)
    {
        m_deck->OnSystray(x, y, Deck::SystrayState::kTooltipClose);
    }
}
// namespace rePlayer