// server.js — synced radio + admin controls + song requests + custom rooms

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { YOUTUBE_API_KEY, ADMIN_PASSWORD, PLAYLISTS } = require("./playlist");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const https = require("https");
setInterval(() => {
  https.get("https://tempo-wala.onrender.com").on('error', (err) => {
    console.log("Self-ping failed:", err.message);
  });
}, 14 * 60 * 1000); // Ping every 14 minutes to prevent sleep

app.get("/", (req, res) => {
  res.send("Backend is running. This URL is only for the server, not the website itself.");
});

// ---- Playlist storage ----
let playlistCache = {}; 

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

async function playVideoById(videoId, startAt, roomCode) {
  try {
    const infoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(infoUrl);
    const data = await res.json();
    if (!data.items || data.items.length === 0) return;
    const item = data.items[0];
    const duration = parseDuration(item.contentDetails.duration);
    playAdhoc(videoId, item.snippet.title, duration, startAt || 0, roomCode);
  } catch (err) {
    console.error("playVideoById error:", err.message);
  }
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
const MAX_CUSTOM_ROOMS = 10;
const rooms = new Map();

function createRoomState(adminId = null) {
  return {
    mode: "playlist", // "playlist" | "adhoc"
    playlistKey: PLAYLISTS[0].key,
    trackIndex: 0,
    trackStartedAt: Date.now(),
    adhocVideo: null, // { videoId, title, durationSeconds }
    resume: null, // { playlistKey, trackIndex, elapsed }
    mainTimer: null,
    adminSocketId: adminId, // For custom rooms
    listeners: new Set(),
    requestQueue: []
  };
}

// Initialize main room
rooms.set("main", createRoomState());

// Global search count
let searchCount = 0;
let searchCountDate = new Date().toDateString();

function bumpSearchCount() {
  const today = new Date().toDateString();
  if (today !== searchCountDate) {
    searchCountDate = today;
    searchCount = 0;
  }
  searchCount++;
  return searchCount;
}

// Generate random room code
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function clearMainTimer(roomState) {
  if (roomState.mainTimer) {
    clearTimeout(roomState.mainTimer);
    roomState.mainTimer = null;
  }
}

function currentElapsedSeconds(roomState) {
  return Math.floor((Date.now() - roomState.trackStartedAt) / 1000);
}

function currentSyncPayload(roomState) {
  var count = roomState.listeners ? roomState.listeners.size : 0;
  if (roomState.mode === "adhoc" && roomState.adhocVideo) {
    return {
      videoId: roomState.adhocVideo.videoId,
      title: roomState.adhocVideo.title,
      elapsed: currentElapsedSeconds(roomState),
      duration: roomState.adhocVideo.durationSeconds,
      upNextTitle: null,
      roomListeners: count
    };
  }
  const list = playlistCache[roomState.playlistKey] || [];
  if (list.length === 0) return null;
  const track = list[roomState.trackIndex % list.length];
  const next = list[(roomState.trackIndex + 1) % list.length];
  return {
    videoId: track.videoId,
    title: track.title,
    elapsed: currentElapsedSeconds(roomState),
    duration: track.durationSeconds,
    upNextTitle: next ? next.title : null,
    roomListeners: count
  };
}

function broadcastSync(roomCode) {
  const roomState = rooms.get(roomCode);
  if (!roomState) return;
  const payload = currentSyncPayload(roomState);
  if (payload) io.to(roomCode).emit("sync", payload);
}

function playPlaylistTrack(key, index, elapsedOverride, roomCode) {
  const roomState = rooms.get(roomCode);
  if (!roomState) return;
  roomState.mode = "playlist";
  roomState.playlistKey = key;
  roomState.trackIndex = index;
  roomState.trackStartedAt = Date.now() - (elapsedOverride || 0) * 1000;
  clearMainTimer(roomState);
  broadcastSync(roomCode);
  scheduleNext(roomCode);
}

function scheduleNext(roomCode) {
  const roomState = rooms.get(roomCode);
  if (!roomState) return;
  clearMainTimer(roomState);
  if (roomState.mode !== "playlist") return;

  const list = playlistCache[roomState.playlistKey] || [];
  if (list.length === 0) {
    roomState.mainTimer = setTimeout(() => scheduleNext(roomCode), 5000);
    return;
  }
  const track = list[roomState.trackIndex % list.length];
  const msLeft = track.durationSeconds * 1000 - (Date.now() - roomState.trackStartedAt);

  roomState.mainTimer = setTimeout(() => {
    const freshRoomState = rooms.get(roomCode);
    if (!freshRoomState || freshRoomState.mode !== "playlist") return;
    const freshList = playlistCache[freshRoomState.playlistKey] || [];
    if (freshList.length === 0) {
      scheduleNext(roomCode);
      return;
    }
    freshRoomState.trackIndex = (freshRoomState.trackIndex + 1) % freshList.length;
    freshRoomState.trackStartedAt = Date.now();
    broadcastSync(roomCode);
    scheduleNext(roomCode);
  }, Math.max(msLeft, 1000));
}

function scheduleAdminChange(key, index, roomCode) {
  const roomState = rooms.get(roomCode);
  if (!roomState) return;
  const list = playlistCache[key] || [];
  if (list.length === 0) return;
  const safeIndex = ((index % list.length) + list.length) % list.length;
  const track = list[safeIndex];

  clearMainTimer(roomState);
  io.to(roomCode).emit("upNext", { title: track.title, seconds: 10 });

  roomState.mainTimer = setTimeout(() => {
    playPlaylistTrack(key, safeIndex, 0, roomCode);
  }, 10000);
}

function playAdhoc(videoId, title, durationSeconds, startAt, roomCode) {
  const roomState = rooms.get(roomCode);
  if (!roomState) return;
  startAt = startAt || 0;
  if (roomState.mode === "playlist") {
    roomState.resume = {
      playlistKey: roomState.playlistKey,
      trackIndex: roomState.trackIndex,
      elapsed: currentElapsedSeconds(roomState),
    };
  }
  roomState.mode = "adhoc";
  roomState.adhocVideo = { videoId, title, durationSeconds };
  roomState.trackStartedAt = Date.now() - startAt * 1000;
  clearMainTimer(roomState);
  broadcastSync(roomCode);

  var remaining = Math.max(durationSeconds - startAt, 1);
  roomState.mainTimer = setTimeout(() => {
    const rs = rooms.get(roomCode);
    if (!rs) return;
    const r = rs.resume || { playlistKey: PLAYLISTS[0].key, trackIndex: 0, elapsed: 0 };
    playPlaylistTrack(r.playlistKey, r.trackIndex, r.elapsed, roomCode);
  }, remaining * 1000);
}

// ---- Live user count + global admin logic ----
let globalUserCount = 0;
let globalAdminSocketId = null;

io.on("connection", (socket) => {
  // Ping listener to measure latency
  socket.on("pingTime", (clientTime) => {
    socket.emit("pongTime", { clientTime, serverTime: Date.now() });
  });

  globalUserCount++;
  io.emit("userCount", globalUserCount);

  let currentRoom = "main";
  socket.join("main");
  rooms.get("main").listeners.add(socket.id);

  const payload = currentSyncPayload(rooms.get("main"));
  if (payload) socket.emit("sync", payload);
  socket.emit("adminStatus", { online: !!globalAdminSocketId || rooms.get("main").adminSocketId === socket.id, isGlobal: !!globalAdminSocketId });
  socket.emit("roomJoined", "main");

  function isAdmin() {
    return socket.id === globalAdminSocketId || (rooms.has(currentRoom) && rooms.get(currentRoom).adminSocketId === socket.id);
  }

  socket.on("createRoom", () => {
    if (rooms.size >= MAX_CUSTOM_ROOMS + 1) {
      return socket.emit("roomError", "Maximum number of rooms reached (10).");
    }
    const code = generateRoomCode();
    rooms.set(code, createRoomState(socket.id));
    
    leaveCurrentRoom();
    currentRoom = code;
    socket.join(code);
    rooms.get(code).listeners.add(socket.id);

    scheduleNext(code);
    
    socket.emit("roomCreated", code);
    const rp = currentSyncPayload(rooms.get(code));
    if (rp) socket.emit("sync", rp);
    
    socket.emit("adminLoginResult", {
      success: true,
      playlists: PLAYLISTS.filter((p) => p.playlistId).map((p) => ({ key: p.key, name: p.name })),
      requests: rooms.get(code).requestQueue,
      currentPlaylistKey: rooms.get(code).playlistKey,
      searchCount: searchCount,
      roomCode: code
    });
    io.to(code).emit("adminStatus", { online: true, isGlobal: false });
  });

  socket.on("joinRoom", (code) => {
    if (!rooms.has(code)) {
      return socket.emit("roomError", "Room not found.");
    }
    leaveCurrentRoom();
    currentRoom = code;
    socket.join(code);
    const rs = rooms.get(code);
    rs.listeners.add(socket.id);
    
    socket.emit("roomJoined", code);
    const rp = currentSyncPayload(rs);
    if (rp) socket.emit("sync", rp);
    socket.emit("adminStatus", { online: !!rs.adminSocketId || !!globalAdminSocketId, isGlobal: false });
  });

  socket.on("leaveRoom", () => {
    leaveCurrentRoom();
    currentRoom = "main";
    socket.join("main");
    rooms.get("main").listeners.add(socket.id);
    socket.emit("roomJoined", "main");
    const rp = currentSyncPayload(rooms.get("main"));
    if (rp) socket.emit("sync", rp);
  });

  function leaveCurrentRoom() {
    if (currentRoom !== "main" && rooms.has(currentRoom)) {
      const rs = rooms.get(currentRoom);
      rs.listeners.delete(socket.id);
      socket.leave(currentRoom);
      
      if (rs.adminSocketId === socket.id) {
        destroyRoom(currentRoom);
      }
    } else if (currentRoom === "main") {
      rooms.get("main").listeners.delete(socket.id);
      socket.leave("main");
    }
  }

  function destroyRoom(code) {
    if (code === "main" || !rooms.has(code)) return;
    const rs = rooms.get(code);
    clearMainTimer(rs);
    io.to(code).emit("roomDestroyed", "Room admin has left. Returning to main radio.");
    rooms.delete(code);
  }

  socket.on("adminLogin", (password) => {
    if (password !== ADMIN_PASSWORD) {
      socket.emit("adminLoginResult", { success: false });
      return;
    }
    if (globalAdminSocketId && globalAdminSocketId !== socket.id) {
      io.to(globalAdminSocketId).emit("adminDemoted");
    }
    globalAdminSocketId = socket.id;
    rooms.get("main").adminSocketId = socket.id;
    if (currentRoom !== "main") {
      leaveCurrentRoom();
      currentRoom = "main";
      socket.join("main");
      rooms.get("main").listeners.add(socket.id);
      socket.emit("roomJoined", "main");
    }
    
    const rs = rooms.get("main");
    socket.emit("adminLoginResult", {
      success: true,
      playlists: PLAYLISTS.filter((p) => p.playlistId).map((p) => ({ key: p.key, name: p.name })),
      requests: rs.requestQueue,
      currentPlaylistKey: rs.playlistKey,
      searchCount: searchCount,
      roomCode: "main"
    });
    io.to("main").emit("adminStatus", { online: true, isGlobal: true });
  });

  socket.on("adminSwitchPlaylist", async (key) => {
    if (!isAdmin()) return;
    if (!playlistCache[key]) await loadPlaylist(key);
    const list = playlistCache[key] || [];
    socket.emit("playlistSongs", {
      key,
      songs: list.map((t, i) => ({ index: i, title: t.title })),
    });
  });

  socket.on("adminPlaySong", (data) => {
    if (!isAdmin()) return;
    const rs = rooms.get(currentRoom);
    if (rs.mode !== "playlist" && !playlistCache[data.key]) return;
    scheduleAdminChange(data.key, data.index, currentRoom);
  });

  socket.on("adminNext", () => {
    if (!isAdmin()) return;
    const rs = rooms.get(currentRoom);
    if (rs.mode !== "playlist") return;
    scheduleAdminChange(rs.playlistKey, rs.trackIndex + 1, currentRoom);
  });

  socket.on("adminPrev", () => {
    if (!isAdmin()) return;
    const rs = rooms.get(currentRoom);
    if (rs.mode !== "playlist") return;
    scheduleAdminChange(rs.playlistKey, rs.trackIndex - 1, currentRoom);
  });

  socket.on("adminSeek", (seconds) => {
    if (!isAdmin()) return;
    const rs = rooms.get(currentRoom);
    seconds = Math.max(0, Math.floor(seconds || 0));
    rs.trackStartedAt = Date.now() - seconds * 1000;
    clearMainTimer(rs);

    const payload = currentSyncPayload(rs);
    if (payload) io.to(currentRoom).emit("resync", { videoId: payload.videoId, elapsed: payload.elapsed });

    if (rs.mode === "playlist") {
      scheduleNext(currentRoom);
    } else if (rs.mode === "adhoc" && rs.adhocVideo) {
      const remaining = Math.max(rs.adhocVideo.durationSeconds - seconds, 1);
      rs.mainTimer = setTimeout(() => {
        const freshRs = rooms.get(currentRoom);
        if (!freshRs) return;
        const r = freshRs.resume || { playlistKey: PLAYLISTS[0].key, trackIndex: 0, elapsed: 0 };
        playPlaylistTrack(r.playlistKey, r.trackIndex, r.elapsed, currentRoom);
      }, remaining * 1000);
    }
  });

  socket.on("adminPlayLink", async (data) => {
    if (!isAdmin()) return;
    var url = typeof data === "string" ? data : data.url;
    var startAt = typeof data === "object" && data.startSeconds ? data.startSeconds : 0;
    const videoId = extractVideoId(url);
    if (!videoId) return;
    await playVideoById(videoId, startAt, currentRoom);
  });

  socket.on("adminSearch", async (query) => {
    if (!isAdmin()) return;
    if (!query || !query.trim()) return;
    try {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=6&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
      const res = await fetch(searchUrl);
      const data = await res.json();
      const count = bumpSearchCount();
      if (!data.items) {
        socket.emit("searchResults", { results: [], searchCount: count });
        return;
      }
      const results = data.items.map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails.default.url,
      }));
      socket.emit("searchResults", { results, searchCount: count });
    } catch (err) {
      console.error("adminSearch error:", err.message);
      socket.emit("searchResults", { results: [], searchCount: searchCount });
    }
  });

  socket.on("adminPlaySearchResult", async (videoId) => {
    if (!isAdmin()) return;
    await playVideoById(videoId, 0, currentRoom);
  });

  socket.on("songRequest", (text) => {
    const rs = rooms.get(currentRoom);
    if (!rs || !rs.adminSocketId) return; // requests only allowed if room has an admin
    if (!text || !text.trim()) return;
    const entry = { id: Date.now(), text: text.trim().slice(0, 200), time: new Date().toLocaleTimeString() };
    rs.requestQueue.push(entry);
    if (rs.requestQueue.length > 5) rs.requestQueue.shift();
    io.to(rs.adminSocketId).emit("newRequest", entry);
  });

  socket.on("adminClearRequests", () => {
    if (!isAdmin()) return;
    const rs = rooms.get(currentRoom);
    if (rs) rs.requestQueue = [];
  });

  socket.on("disconnect", () => {
    globalUserCount--;
    io.emit("userCount", globalUserCount);
    leaveCurrentRoom();
    if (socket.id === globalAdminSocketId) {
      globalAdminSocketId = null;
      if (rooms.has("main")) {
        rooms.get("main").adminSocketId = null;
        io.to("main").emit("adminStatus", { online: false, isGlobal: false });
      }
    }
  });
});

// ---- Startup ----
(async () => {
  await loadAllPlaylists();
  scheduleNext("main");
})();

setInterval(loadAllPlaylists, 10 * 60 * 1000);

// Continuous drift-correction per room
setInterval(() => {
  for (const [roomCode, rs] of rooms.entries()) {
    const payload = currentSyncPayload(rs);
    if (payload) {
      io.to(roomCode).emit("resync", { videoId: payload.videoId, elapsed: payload.elapsed });
    }
  }
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));