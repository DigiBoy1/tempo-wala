// server.js — synced radio + admin controls + song requests

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { YOUTUBE_API_KEY, ADMIN_PASSWORD, PLAYLISTS } = require("./playlist");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (req, res) => {
  res.send("Backend is running. This URL is only for the server, not the website itself.");
});

// ---- Playlist storage ----
let playlistCache = {}; // key -> array of { videoId, durationSeconds, title }

function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const h = parseInt(match[1] || 0, 10);
  const m = parseInt(match[2] || 0, 10);
  const s = parseInt(match[3] || 0, 10);
  return h * 3600 + m * 60 + s;
}

function extractVideoId(url) {
  const patterns = [/(?:v=)([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function loadPlaylist(key) {
  const meta = PLAYLISTS.find((p) => p.key === key);
  if (!meta || !meta.playlistId) return [];
  try {
    const listUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${meta.playlistId}&key=${YOUTUBE_API_KEY}`;
    const listRes = await fetch(listUrl);
    const listData = await listRes.json();
    if (!listData.items) {
      console.error(`Could not load playlist "${meta.name}" — check its ID and API key.`);
      return [];
    }
    const videoIds = listData.items.map((i) => i.contentDetails.videoId).join(",");
    const durUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const durRes = await fetch(durUrl);
    const durData = await durRes.json();
    const tracks = durData.items.map((item) => ({
      videoId: item.id,
      durationSeconds: parseDuration(item.contentDetails.duration),
      title: item.snippet.title,
    }));
    playlistCache[key] = tracks;
    console.log(`Loaded ${tracks.length} songs for playlist "${meta.name}"`);
    return tracks;
  } catch (err) {
    console.error("Error loading playlist:", err.message);
    return [];
  }
}

async function loadAllPlaylists() {
  for (const p of PLAYLISTS) {
    if (p.playlistId) await loadPlaylist(p.key);
  }
}

// ---- Shared playback state ----
let state = {
  mode: "playlist", // "playlist" | "adhoc"
  playlistKey: PLAYLISTS[0].key,
  trackIndex: 0,
  trackStartedAt: Date.now(),
  adhocVideo: null, // { videoId, title, durationSeconds }
  resume: null, // { playlistKey, trackIndex, elapsed } — saved when an adhoc link starts playing
};

let mainTimer = null;

function clearMainTimer() {
  if (mainTimer) {
    clearTimeout(mainTimer);
    mainTimer = null;
  }
}

function currentElapsedSeconds() {
  return Math.floor((Date.now() - state.trackStartedAt) / 1000);
}

function currentSyncPayload() {
  if (state.mode === "adhoc" && state.adhocVideo) {
    return {
      videoId: state.adhocVideo.videoId,
      title: state.adhocVideo.title,
      elapsed: currentElapsedSeconds(),
      duration: state.adhocVideo.durationSeconds,
      upNextTitle: null,
    };
  }
  const list = playlistCache[state.playlistKey] || [];
  if (list.length === 0) return null;
  const track = list[state.trackIndex % list.length];
  const next = list[(state.trackIndex + 1) % list.length];
  return {
    videoId: track.videoId,
    title: track.title,
    elapsed: currentElapsedSeconds(),
    duration: track.durationSeconds,
    upNextTitle: next ? next.title : null,
  };
}

function broadcastSync() {
  const payload = currentSyncPayload();
  if (payload) io.emit("sync", payload);
}

function playPlaylistTrack(key, index, elapsedOverride) {
  state.mode = "playlist";
  state.playlistKey = key;
  state.trackIndex = index;
  state.trackStartedAt = Date.now() - (elapsedOverride || 0) * 1000;
  clearMainTimer();
  broadcastSync();
  scheduleNext();
}

function scheduleNext() {
  clearMainTimer();
  if (state.mode !== "playlist") return;

  const list = playlistCache[state.playlistKey] || [];
  if (list.length === 0) {
    mainTimer = setTimeout(scheduleNext, 5000);
    return;
  }
  const track = list[state.trackIndex % list.length];
  const msLeft = track.durationSeconds * 1000 - (Date.now() - state.trackStartedAt);

  mainTimer = setTimeout(() => {
    if (state.mode !== "playlist") return;
    const freshList = playlistCache[state.playlistKey] || [];
    if (freshList.length === 0) {
      scheduleNext();
      return;
    }
    state.trackIndex = (state.trackIndex + 1) % freshList.length;
    state.trackStartedAt = Date.now();
    broadcastSync();
    scheduleNext();
  }, Math.max(msLeft, 1000));
}

// Admin-triggered change: waits 10s (so it feels intentional, not jarring) and
// tells everyone what's coming up next before it actually switches.
function scheduleAdminChange(key, index) {
  const list = playlistCache[key] || [];
  if (list.length === 0) return;
  const safeIndex = ((index % list.length) + list.length) % list.length;
  const track = list[safeIndex];

  clearMainTimer();
  io.emit("upNext", { title: track.title, seconds: 10 });

  mainTimer = setTimeout(() => {
    playPlaylistTrack(key, safeIndex, 0);
  }, 10000);
}

function playAdhoc(videoId, title, durationSeconds, startAt) {
  startAt = startAt || 0;
  if (state.mode === "playlist") {
    state.resume = {
      playlistKey: state.playlistKey,
      trackIndex: state.trackIndex,
      elapsed: currentElapsedSeconds(),
    };
  }
  state.mode = "adhoc";
  state.adhocVideo = { videoId, title, durationSeconds };
  state.trackStartedAt = Date.now() - startAt * 1000;
  clearMainTimer();
  broadcastSync();

  var remaining = Math.max(durationSeconds - startAt, 1);
  mainTimer = setTimeout(() => {
    const r = state.resume || { playlistKey: PLAYLISTS[0].key, trackIndex: 0, elapsed: 0 };
    playPlaylistTrack(r.playlistKey, r.trackIndex, r.elapsed);
  }, remaining * 1000);
}

// ---- Live user count + admin session ----
let userCount = 0;
let adminSocketId = null;
let requestQueue = [];

io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);

  const payload = currentSyncPayload();
  if (payload) socket.emit("sync", payload);
  socket.emit("adminStatus", { online: !!adminSocketId });

  socket.on("adminLogin", (password) => {
    if (password !== ADMIN_PASSWORD) {
      socket.emit("adminLoginResult", { success: false });
      return;
    }
    if (adminSocketId && adminSocketId !== socket.id) {
      io.to(adminSocketId).emit("adminDemoted");
    }
    adminSocketId = socket.id;
    socket.emit("adminLoginResult", {
      success: true,
      playlists: PLAYLISTS.filter((p) => p.playlistId).map((p) => ({ key: p.key, name: p.name })),
      requests: requestQueue,
      currentPlaylistKey: state.playlistKey,
    });
    io.emit("adminStatus", { online: true });
  });

  socket.on("adminSwitchPlaylist", async (key) => {
    if (socket.id !== adminSocketId) return;
    if (!playlistCache[key]) await loadPlaylist(key);
    const list = playlistCache[key] || [];
    socket.emit("playlistSongs", {
      key,
      songs: list.map((t, i) => ({ index: i, title: t.title })),
    });
  });

  socket.on("adminPlaySong", (data) => {
    if (socket.id !== adminSocketId) return;
    if (state.mode !== "playlist" && !playlistCache[data.key]) return;
    scheduleAdminChange(data.key, data.index);
  });

  socket.on("adminNext", () => {
    if (socket.id !== adminSocketId || state.mode !== "playlist") return;
    scheduleAdminChange(state.playlistKey, state.trackIndex + 1);
  });

  socket.on("adminPrev", () => {
    if (socket.id !== adminSocketId || state.mode !== "playlist") return;
    scheduleAdminChange(state.playlistKey, state.trackIndex - 1);
  });

  // Jump to a specific point within the CURRENT song (drag/tap the timeline)
  socket.on("adminSeek", (seconds) => {
    if (socket.id !== adminSocketId) return;
    seconds = Math.max(0, Math.floor(seconds || 0));
    state.trackStartedAt = Date.now() - seconds * 1000;
    clearMainTimer();

    const payload = currentSyncPayload();
    if (payload) io.emit("resync", { videoId: payload.videoId, elapsed: payload.elapsed });

    if (state.mode === "playlist") {
      scheduleNext();
    } else if (state.mode === "adhoc" && state.adhocVideo) {
      const remaining = Math.max(state.adhocVideo.durationSeconds - seconds, 1);
      mainTimer = setTimeout(() => {
        const r = state.resume || { playlistKey: PLAYLISTS[0].key, trackIndex: 0, elapsed: 0 };
        playPlaylistTrack(r.playlistKey, r.trackIndex, r.elapsed);
      }, remaining * 1000);
    }
  });

  socket.on("adminPlayLink", async (data) => {
    if (socket.id !== adminSocketId) return;
    var url = typeof data === "string" ? data : data.url;
    var startAt = typeof data === "object" && data.startSeconds ? data.startSeconds : 0;
    const videoId = extractVideoId(url);
    if (!videoId) return;
    try {
      const infoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
      const res = await fetch(infoUrl);
      const data2 = await res.json();
      if (!data2.items || data2.items.length === 0) return;
      const item = data2.items[0];
      const duration = parseDuration(item.contentDetails.duration);
      playAdhoc(videoId, item.snippet.title, duration, startAt);
    } catch (err) {
      console.error("adminPlayLink error:", err.message);
    }
  });

  socket.on("songRequest", (text) => {
    if (!adminSocketId) return; // requests only allowed while admin is online
    if (!text || !text.trim()) return;
    const entry = { id: Date.now(), text: text.trim().slice(0, 200), time: new Date().toLocaleTimeString() };
    requestQueue.push(entry);
    if (requestQueue.length > 5) requestQueue.shift();
    io.to(adminSocketId).emit("newRequest", entry);
  });

  socket.on("adminClearRequests", () => {
    if (socket.id !== adminSocketId) return;
    requestQueue = [];
  });

  socket.on("disconnect", () => {
    userCount--;
    io.emit("userCount", userCount);
    if (socket.id === adminSocketId) {
      adminSocketId = null;
      io.emit("adminStatus", { online: false });
    }
  });
});

// ---- Startup ----
(async () => {
  await loadAllPlaylists();
  scheduleNext();
})();

setInterval(loadAllPlaylists, 10 * 60 * 1000);

// Continuous drift-correction — every 15s, tell everyone exactly where playback
// should be right now. Clients that have drifted just quietly snap back into
// place instead of reloading the whole video.
setInterval(() => {
  const payload = currentSyncPayload();
  if (payload) {
    io.emit("resync", { videoId: payload.videoId, elapsed: payload.elapsed });
  }
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));