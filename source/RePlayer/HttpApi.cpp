#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "Ws2_32.lib")

#include "HttpApi.h"

#include <Core/Log.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace rePlayer
{
    namespace
    {
        constexpr uintptr_t kInvalidSocket = ~uintptr_t(0);
        constexpr size_t kMaxRequestSize = 64 * 1024;

        const char* const kIndexHtml = R"HTML(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rePlayer remote</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d10;
    --panel: #14181e;
    --panel-2: #1b2129;
    --text: #e8edf3;
    --muted: #8b97a6;
    --accent: #3fa7ff;
    --accent-2: #1b6fb3;
    --ok: #45d483;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: radial-gradient(circle at top, #17202b 0%, var(--bg) 55%);
    color: var(--text);
    font: 15px/1.4 "Segoe UI", system-ui, sans-serif;
    display: flex;
    justify-content: center;
    padding: 24px 16px 48px;
  }
  .app { width: min(720px, 100%); }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
    color: var(--muted);
    letter-spacing: .08em;
    text-transform: uppercase;
    font-size: 12px;
  }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--text); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
  .dot.playing { background: var(--ok); box-shadow: 0 0 10px var(--ok); }
  .dot.paused { background: #f5c451; }
  .dot.stopped, .dot.idle { background: #59636f; }
  .panel {
    background: linear-gradient(180deg, var(--panel), var(--panel-2));
    border: 1px solid #232b34;
    border-radius: 16px;
    padding: 22px;
    box-shadow: 0 18px 50px rgba(0,0,0,.35);
  }
  .now { display: flex; gap: 16px; align-items: center; min-height: 72px; }
  .art {
    width: 72px; height: 72px; border-radius: 12px; flex: none;
    display: grid; place-items: center;
    background: linear-gradient(135deg, var(--accent-2), #2b1d55);
    font-size: 30px;
  }
  h1 { margin: 0 0 4px; font-size: 20px; line-height: 1.2; }
  #artists { margin: 0; color: var(--muted); }
  #meta {
    margin: 6px 0 0; color: var(--muted); font-size: 12px;
    white-space: pre-wrap; max-height: 54px; overflow: hidden;
  }
  .progress { margin-top: 22px; }
  input[type=range] { width: 100%; accent-color: var(--accent); }
  .times { display: flex; justify-content: space-between; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; margin-top: 2px; }
  .controls { display: flex; justify-content: center; gap: 14px; margin: 18px 0; }
  button {
    border: 1px solid #2d3742;
    background: #1a2028;
    color: var(--text);
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 18px;
    cursor: pointer;
    transition: transform .08s ease, background .15s ease, border-color .15s ease;
  }
  button:hover { background: #222b35; border-color: #3c4b5a; }
  button:active { transform: scale(.96); }
  button:disabled { opacity: .35; cursor: default; }
  button.primary {
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
    border-color: transparent;
    min-width: 64px;
    font-size: 22px;
  }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .row input[type=range] { flex: 1; }
  select {
    background: #1a2028; color: var(--text); border: 1px solid #2d3742;
    border-radius: 8px; padding: 8px 10px;
  }
  .playlist { margin-top: 22px; }
  .playlist h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; }
  ol { list-style: none; margin: 0; padding: 0; max-height: 340px; overflow: auto; }
  li { border-radius: 8px; }
  li button {
    width: 100%; text-align: left; font-size: 13px; padding: 8px 10px;
    background: transparent; border: 1px solid transparent; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  li button:hover { background: #1e2630; }
  li.playing button { color: var(--accent); font-weight: 600; }
  .empty { color: var(--muted); font-size: 13px; padding: 8px 2px; }
  footer { margin-top: 14px; color: var(--muted); font-size: 11px; text-align: center; }
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand"><span class="dot idle" id="dot"></span> rePlayer remote</div>
    <div id="state">idle</div>
  </header>

  <div class="panel">
    <div class="now">
      <div class="art">&#9835;</div>
      <div class="info">
        <h1 id="title">Nothing playing</h1>
        <p id="artists"></p>
        <p id="meta"></p>
      </div>
    </div>

    <div class="progress">
      <input type="range" id="seek" min="0" max="1000" value="0" disabled>
      <div class="times"><span id="time">0:00</span><span id="duration">0:00</span></div>
    </div>

    <div class="controls">
      <button id="prev" title="Previous">&#9198;</button>
      <button id="play" class="primary" title="Play / Pause">&#9654;</button>
      <button id="stop" title="Stop">&#9209;</button>
      <button id="next" title="Next">&#9197;</button>
    </div>

    <div class="row">
      <button id="mute" title="Mute">&#128266;</button>
      <input type="range" id="vol" min="0" max="100" value="80">
      <select id="loop" title="Loop">
        <option value="0">No loop</option>
        <option value="1">Playlist</option>
        <option value="2">Single</option>
      </select>
    </div>

    <div class="playlist">
      <h2>Playlist <span id="plcount"></span></h2>
      <ol id="pl"><li class="empty">Empty</li></ol>
    </div>
  </div>

  <footer>rePlayer HTTP API &middot; <span id="api">/api/status</span></footer>
</div>
<script>
  const $ = id => document.getElementById(id);
  let status = null;
  let seeking = false;
  let lastCount = -1;

  function fmt(ms) {
    ms = Math.max(0, Math.floor(ms || 0));
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  async function post(path) {
    try { await fetch(path, { method: 'POST', cache: 'no-store' }); } catch (e) {}
    refresh();
  }

  function render(s) {
    status = s;
    $('title').textContent = s.title || 'Nothing playing';
    $('artists').textContent = s.artists || '';
    $('meta').textContent = s.metadata || '';
    $('state').textContent = s.state || 'idle';
    $('dot').className = 'dot ' + (s.state || 'idle');
    $('play').textContent = s.state === 'playing' ? '\u23F8' : '\u25B6';
    $('play').disabled = !s.hasSong && (s.playlist ? s.playlist.count === 0 : true);
    $('seek').disabled = !s.seekable;
    if (!seeking) {
      const max = Math.max(1, s.durationMs || 0);
      $('seek').value = String(Math.round((s.timeMs || 0) / max * 1000));
    }
    $('time').textContent = fmt(s.timeMs);
    $('duration').textContent = fmt(s.durationMs);
    $('mute').textContent = s.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    if (document.activeElement !== $('vol')) $('vol').value = String(s.volume || 0);
    $('loop').value = String(s.loop || 0);
    $('plcount').textContent = s.playlist && s.playlist.count ? '(' + s.playlist.count + ')' : '';
  }

  async function refresh() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (r.ok) render(await r.json());
    } catch (e) {}
  }

  async function loadPlaylist() {
    try {
      const r = await fetch('/api/playlist', { cache: 'no-store' });
      if (!r.ok) return;
      const p = await r.json();
      if (!p.entries) return;
      lastCount = p.count;
      const ol = $('pl');
      ol.innerHTML = '';
      if (!p.entries.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'Empty';
        ol.appendChild(li);
        return;
      }
      p.entries.forEach(entry => {
        const li = document.createElement('li');
        if (entry.index === p.current) li.className = 'playing';
        const b = document.createElement('button');
        b.textContent = (entry.artists ? entry.artists + ' \u2014 ' : '') + entry.title;
        b.onclick = () => post('/api/play?index=' + entry.index);
        li.appendChild(b);
        ol.appendChild(li);
      });
    } catch (e) {}
  }

  $('play').onclick = () => post('/api/playpause');
  $('next').onclick = () => post('/api/next');
  $('prev').onclick = () => post('/api/previous');
  $('stop').onclick = () => post('/api/stop');
  $('mute').onclick = () => post('/api/mute');
  $('seek').oninput = () => { seeking = true; };
  $('seek').onchange = () => {
    if (status) post('/api/seek?ms=' + Math.round($('seek').value / 1000 * (status.durationMs || 0)));
    seeking = false;
  };
  $('vol').onchange = () => post('/api/volume?value=' + $('vol').value);
  $('loop').onchange = () => post('/api/loop?value=' + $('loop').value);

  refresh();
  loadPlaylist();
  setInterval(refresh, 500);
  setInterval(() => {
    if (status && status.playlist && status.playlist.count !== lastCount) loadPlaylist();
  }, 1500);
</script>
</body>
</html>)HTML";

        std::string UrlDecode(const std::string& value)
        {
            std::string result;
            result.reserve(value.size());
            for (size_t i = 0; i < value.size(); i++)
            {
                auto c = value[i];
                if (c == '+')
                    result += ' ';
                else if (c == '%' && i + 2 < value.size())
                {
                    auto hex = [](char h) -> int
                    {
                        if (h >= '0' && h <= '9') return h - '0';
                        if (h >= 'a' && h <= 'f') return h - 'a' + 10;
                        if (h >= 'A' && h <= 'F') return h - 'A' + 10;
                        return -1;
                    };
                    int hi = hex(value[i + 1]);
                    int lo = hex(value[i + 2]);
                    if (hi >= 0 && lo >= 0)
                    {
                        result += char(hi * 16 + lo);
                        i += 2;
                    }
                    else
                        result += c;
                }
                else
                    result += c;
            }
            return result;
        }

        std::string ExtractValue(const std::string& source, const char* key)
        {
            if (source.empty())
                return {};

            std::string keyName(key);

            // application/x-www-form-urlencoded or query string: key=value
            auto pos = source.find(keyName + "=");
            if (pos != std::string::npos && (pos == 0 || source[pos - 1] == '&'))
            {
                auto start = pos + keyName.size() + 1;
                auto end = source.find('&', start);
                return UrlDecode(source.substr(start, end == std::string::npos ? std::string::npos : end - start));
            }

            // simple JSON: "key":value or "key":"value"
            pos = source.find('"' + keyName + '"');
            if (pos != std::string::npos)
            {
                auto colon = source.find(':', pos + keyName.size() + 2);
                if (colon != std::string::npos)
                {
                    auto i = colon + 1;
                    while (i < source.size() && isspace(static_cast<unsigned char>(source[i])))
                        i++;
                    if (i < source.size() && source[i] == '"')
                    {
                        i++;
                        auto end = source.find('"', i);
                        return source.substr(i, end == std::string::npos ? std::string::npos : end - i);
                    }
                    auto end = i;
                    while (end < source.size() && source[end] != ',' && source[end] != '}' && !isspace(static_cast<unsigned char>(source[end])))
                        end++;
                    return source.substr(i, end - i);
                }
            }
            return {};
        }

        int32_t ToInt(const std::string& value, int32_t defaultValue)
        {
            if (value.empty())
                return defaultValue;
            char* end = nullptr;
            long result = strtol(value.c_str(), &end, 10);
            return end == value.c_str() ? defaultValue : int32_t(result);
        }

        bool ToBool(const std::string& value, bool defaultValue)
        {
            if (value.empty())
                return defaultValue;
            if (value == "1" || value == "true" || value == "yes" || value == "on")
                return true;
            if (value == "0" || value == "false" || value == "no" || value == "off")
                return false;
            return defaultValue;
        }

        std::string BuildStatusJson(const ApiStatus& status)
        {
            std::string json;
            json.reserve(512);
            json += "{\"hasSong\":";
            json += status.hasSong ? "true" : "false";
            json += ",\"state\":\"";
            json += status.hasSong ? (status.isPlaying ? "playing" : (status.isPaused ? "paused" : "stopped")) : "idle";
            json += "\",\"title\":";
            json += JsonEscape(status.title);
            json += ",\"artists\":";
            json += JsonEscape(status.artists);
            json += ",\"metadata\":";
            json += JsonEscape(status.metadata);
            json += ",\"timeMs\":";
            json += std::to_string(status.timeMs);
            json += ",\"durationMs\":";
            json += std::to_string(status.durationMs);
            json += ",\"seekable\":";
            json += status.isSeekable ? "true" : "false";
            json += ",\"volume\":";
            json += std::to_string(status.volume);
            json += ",\"muted\":";
            json += status.isMuted ? "true" : "false";
            json += ",\"loop\":\"";
            json += status.loopMode == 1 ? "playlist" : (status.loopMode == 2 ? "single" : "none");
            json += "\",\"playlist\":{\"index\":";
            json += std::to_string(status.playlistIndex);
            json += ",\"count\":";
            json += std::to_string(status.playlistCount);
            json += "}}";
            return json;
        }

        void SendResponse(SOCKET client, int code, const char* reason, const char* contentType, const std::string& body)
        {
            std::string header;
            header.reserve(256);
            header += "HTTP/1.1 ";
            header += std::to_string(code);
            header += ' ';
            header += reason;
            header += "\r\nContent-Type: ";
            header += contentType;
            header += "\r\nContent-Length: ";
            header += std::to_string(body.size());
            header += "\r\nCache-Control: no-store\r\n";
            header += "Access-Control-Allow-Origin: *\r\n";
            header += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
            header += "Access-Control-Allow-Headers: Content-Type\r\n";
            header += "Connection: close\r\n\r\n";
            send(client, header.data(), int(header.size()), 0);
            if (!body.empty())
                send(client, body.data(), int(body.size()), 0);
        }

        void SendJson(SOCKET client, int code, const std::string& body)
        {
            SendResponse(client, code, code == 200 ? "OK" : (code == 204 ? "No Content" : "Bad Request"), "application/json; charset=utf-8", body);
        }

        void SendOk(SOCKET client)
        {
            SendJson(client, 200, "{\"ok\":true}");
        }

        void SendError(SOCKET client, int code, const char* message)
        {
            SendJson(client, code, "{\"ok\":false,\"error\":" + JsonEscape(message) + "}");
        }

        bool ReadRequest(SOCKET client, std::string& raw, std::string& body)
        {
            raw.clear();
            body.clear();

            char buffer[4096];
            size_t headerEnd = std::string::npos;
            while (raw.size() < kMaxRequestSize)
            {
                int received = recv(client, buffer, sizeof(buffer), 0);
                if (received <= 0)
                    return false;
                raw.append(buffer, received);
                headerEnd = raw.find("\r\n\r\n");
                if (headerEnd != std::string::npos)
                    break;
            }
            if (headerEnd == std::string::npos)
                return false;

            body = raw.substr(headerEnd + 4);

            size_t contentLength = 0;
            {
                auto headers = raw.substr(0, headerEnd);
                std::transform(headers.begin(), headers.end(), headers.begin(), [](unsigned char c) { return char(tolower(c)); });
                auto pos = headers.find("content-length:");
                if (pos != std::string::npos)
                    contentLength = size_t(strtoul(headers.c_str() + pos + 15, nullptr, 10));
            }

            while (body.size() < contentLength && body.size() < kMaxRequestSize)
            {
                int received = recv(client, buffer, sizeof(buffer), 0);
                if (received <= 0)
                    break;
                body.append(buffer, received);
            }
            return true;
        }
    }

    std::string JsonEscape(const std::string& value)
    {
        std::string result;
        result.reserve(value.size() + 2);
        result += '"';
        for (unsigned char c : value)
        {
            switch (c)
            {
            case '"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            case '\b': result += "\\b"; break;
            case '\f': result += "\\f"; break;
            default:
                if (c < 0x20)
                {
                    char escaped[8];
                    snprintf(escaped, sizeof(escaped), "\\u%04x", c);
                    result += escaped;
                }
                else
                    result += char(c);
                break;
            }
        }
        result += '"';
        return result;
    }

    HttpApi* HttpApi::Create(uint16_t port, bool isLanEnabled)
    {
        auto* api = new HttpApi(port, isLanEnabled);
        if (!api->Start())
        {
            delete api;
            return nullptr;
        }
        return api;
    }

    HttpApi::HttpApi(uint16_t port, bool isLanEnabled)
        : m_port(port)
        , m_isLanEnabled(isLanEnabled)
    {
        m_lastStatusUpdate = std::chrono::steady_clock::now() - std::chrono::seconds(1);
    }

    HttpApi::~HttpApi()
    {
        Stop();
    }

    bool HttpApi::Start()
    {
        WSADATA wsaData;
        if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
            return false;

        SOCKET listenSocket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listenSocket == INVALID_SOCKET)
        {
            WSACleanup();
            return false;
        }

        BOOL reuseAddress = TRUE;
        setsockopt(listenSocket, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuseAddress), sizeof(reuseAddress));

        sockaddr_in address = {};
        address.sin_family = AF_INET;
        address.sin_port = htons(m_port);
        address.sin_addr.s_addr = m_isLanEnabled ? htonl(INADDR_ANY) : htonl(INADDR_LOOPBACK);

        if (bind(listenSocket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR
            || listen(listenSocket, SOMAXCONN) == SOCKET_ERROR)
        {
            closesocket(listenSocket);
            WSACleanup();
            return false;
        }

        m_listenSocket = uintptr_t(listenSocket);
        m_isRunning = true;
        m_thread = std::thread(&HttpApi::Run, this);
        return true;
    }

    void HttpApi::Stop()
    {
        if (!m_isRunning.exchange(false))
            return;

        auto socket = m_listenSocket.exchange(kInvalidSocket);
        if (socket != kInvalidSocket)
            closesocket(SOCKET(socket));

        if (m_thread.joinable())
            m_thread.join();

        WSACleanup();
    }

    void HttpApi::Run()
    {
        while (m_isRunning)
        {
            auto listenSocket = m_listenSocket.load();
            if (listenSocket == kInvalidSocket)
                break;

            fd_set readSet;
            FD_ZERO(&readSet);
            FD_SET(SOCKET(listenSocket), &readSet);
            timeval timeout = { 0, 200000 };

            if (select(0, &readSet, nullptr, nullptr, &timeout) <= 0)
                continue;

            SOCKET client = accept(SOCKET(listenSocket), nullptr, nullptr);
            if (client == INVALID_SOCKET)
                continue;

            HandleClient(uintptr_t(client));
            closesocket(client);
        }
    }

    void HttpApi::HandleClient(uintptr_t clientHandle)
    {
        SOCKET client = SOCKET(clientHandle);

        DWORD timeout = 3000;
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));

        std::string raw;
        std::string body;
        if (!ReadRequest(client, raw, body))
            return;

        auto headerEnd = raw.find("\r\n\r\n");
        auto headers = raw.substr(0, headerEnd);
        auto lineEnd = headers.find("\r\n");
        auto requestLine = headers.substr(0, lineEnd == std::string::npos ? headers.size() : lineEnd);

        auto firstSpace = requestLine.find(' ');
        auto secondSpace = firstSpace == std::string::npos ? std::string::npos : requestLine.find(' ', firstSpace + 1);
        if (firstSpace == std::string::npos)
            return;

        std::string method = requestLine.substr(0, firstSpace);
        std::string target = requestLine.substr(firstSpace + 1, secondSpace == std::string::npos ? std::string::npos : secondSpace - firstSpace - 1);

        std::string path = target;
        std::string query;
        if (auto queryPos = target.find('?'); queryPos != std::string::npos)
        {
            path = target.substr(0, queryPos);
            query = target.substr(queryPos + 1);
        }

        if (method == "OPTIONS")
        {
            SendResponse(client, 204, "No Content", "text/plain", {});
            return;
        }

        if (method == "GET" && (path == "/" || path == "/index.html"))
        {
            SendResponse(client, 200, "OK", "text/html; charset=utf-8", kIndexHtml);
            return;
        }

        if (method == "GET" && path == "/api/status")
        {
            SendJson(client, 200, GetStatusJson());
            return;
        }

        if (method == "GET" && path == "/api/playlist")
        {
            SendJson(client, 200, GetPlaylistJson(3000));
            return;
        }

        if (method == "GET" && path == "/api")
        {
            std::string json = "{\"name\":\"rePlayer\",\"api\":1,\"endpoints\":[";
            json += "\"/api/status\",\"/api/playlist\",\"/api/playpause\",\"/api/next\",\"/api/previous\",\"/api/stop\",";
            json += "\"/api/volume?value=0..100\",\"/api/mute\",\"/api/seek?ms=0..\",\"/api/play?index=0..\",\"/api/loop?value=none|playlist|single\"]}";
            SendJson(client, 200, json);
            return;
        }

        if (method != "POST")
        {
            SendError(client, 400, "unsupported method");
            return;
        }

        if (path == "/api/playpause")
        {
            Enqueue(CommandType::PlayPause);
            SendOk(client);
        }
        else if (path == "/api/next")
        {
            Enqueue(CommandType::Next);
            SendOk(client);
        }
        else if (path == "/api/previous")
        {
            Enqueue(CommandType::Previous);
            SendOk(client);
        }
        else if (path == "/api/stop")
        {
            Enqueue(CommandType::Stop);
            SendOk(client);
        }
        else if (path == "/api/volume")
        {
            auto value = ExtractValue(query, "value");
            if (value.empty())
                value = ExtractValue(body, "value");
            if (value.empty())
            {
                SendError(client, 400, "missing value");
                return;
            }
            auto percent = ToInt(value, -1);
            if (percent < 0)
            {
                SendError(client, 400, "invalid value");
                return;
            }
            percent = std::clamp(percent, 0, 100);
            Enqueue(CommandType::SetVolume, percent * 65535 / 100);
            SendOk(client);
        }
        else if (path == "/api/mute")
        {
            auto value = ExtractValue(query, "value");
            if (value.empty())
                value = ExtractValue(body, "value");
            if (value.empty())
                Enqueue(CommandType::ToggleMute);
            else
                Enqueue(CommandType::SetMuted, ToBool(value, false) ? 1 : 0);
            SendOk(client);
        }
        else if (path == "/api/seek")
        {
            auto value = ExtractValue(query, "ms");
            if (value.empty())
                value = ExtractValue(body, "ms");
            auto ms = ToInt(value, -1);
            if (ms < 0)
            {
                SendError(client, 400, "missing ms");
                return;
            }
            Enqueue(CommandType::Seek, ms);
            SendOk(client);
        }
        else if (path == "/api/play")
        {
            auto value = ExtractValue(query, "index");
            if (value.empty())
                value = ExtractValue(body, "index");
            auto index = ToInt(value, -1);
            if (index < 0)
            {
                SendError(client, 400, "missing index");
                return;
            }
            Enqueue(CommandType::PlayIndex, index);
            SendOk(client);
        }
        else if (path == "/api/loop")
        {
            auto value = ExtractValue(query, "value");
            if (value.empty())
                value = ExtractValue(body, "value");
            int32_t mode = -1;
            if (value == "0" || value == "none")
                mode = 0;
            else if (value == "1" || value == "playlist")
                mode = 1;
            else if (value == "2" || value == "single")
                mode = 2;
            if (mode < 0)
            {
                SendError(client, 400, "invalid value");
                return;
            }
            Enqueue(CommandType::SetLoop, mode);
            SendOk(client);
        }
        else
            SendError(client, 400, "unknown endpoint");
    }

    void HttpApi::Enqueue(CommandType type, int32_t value)
    {
        std::lock_guard lock(m_commandMutex);
        m_commands.push_back(Command{ type, value });
    }

    void HttpApi::Update(const ApiStatus& status)
    {
        auto now = std::chrono::steady_clock::now();
        if (now - m_lastStatusUpdate < std::chrono::milliseconds(200))
            return;
        m_lastStatusUpdate = now;

        auto json = BuildStatusJson(status);
        std::lock_guard lock(m_statusMutex);
        m_statusJson = std::move(json);
    }

    void HttpApi::DrainCommands(std::vector<Command>& commands)
    {
        std::lock_guard lock(m_commandMutex);
        commands.swap(m_commands);
    }

    bool HttpApi::ConsumePlaylistRequest()
    {
        return m_hasPlaylistRequest.exchange(false);
    }

    void HttpApi::SetPlaylistJson(std::string json)
    {
        std::lock_guard lock(m_playlistMutex);
        m_playlistJson = std::move(json);
        m_playlistVersion++;
        m_playlistCv.notify_all();
    }

    std::string HttpApi::GetStatusJson()
    {
        std::lock_guard lock(m_statusMutex);
        return m_statusJson;
    }

    std::string HttpApi::GetPlaylistJson(uint32_t timeoutMs)
    {
        std::unique_lock lock(m_playlistMutex);
        auto startVersion = m_playlistVersion;
        m_hasPlaylistRequest = true;
        if (!m_playlistCv.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] { return m_playlistVersion != startVersion; }))
            return "{\"current\":-1,\"count\":0,\"entries\":[],\"error\":\"timeout\"}";
        return m_playlistJson;
    }
}
// namespace rePlayer
