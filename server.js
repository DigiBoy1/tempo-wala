// server.js — auto-pulls songs from your YouTube playlist link.
// You only fill in 2 values in playlist.js — no manual video IDs needed anymore.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { YOUTUBE_API_KEY, PLAYLIST_ID } = require("./playlist");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (req, res) => {
  res.send("Backend is running. This URL is only for the server, not the website itself.");
});

let playlist = []; // will be filled automatically from YouTube

// Convert YouTube's duration format (e.g. "PT3M45S") into seconds
function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const h = parseInt(match[1] || 0, 10);
  const m = parseInt(match[2] || 0, 10);
  const s = parseInt(match[3] || 0, 10);
  return h * 3600 + m * 60 + s;
}

// Pull the current songs in the playlist from YouTube (free API, generous daily limit)
async function fetchPlaylist() {
  try {
    const listUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${PLAYLIST_ID}&key=${YOUTUBE_API_KEY}`;
    const listRes = await fetch(listUrl);
    const listData = await listRes.json();

    if (!listData.items) {
      console.error("Could not read playlist — check your API key and playlist link in playlist.js");
      return;
    }

    const videoIds = listData.items.map((item) => item.contentDetails.videoId).join(",");

    const durUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const durRes = await fetch(durUrl);
    const durData = await durRes.json();

    playlist = durData.items.map((item) => ({
      videoId: item.id,
      durationSeconds: parseDuration(item.contentDetails.duration),
    }));

    console.log(`Loaded ${playlist.length} songs from your playlist.`);
  } catch (err) {
    console.error("Error fetching playlist:", err.message);
  }
}

// Refresh the song list every 10 minutes, so newly added songs show up automatically
fetchPlaylist();
setInterval(fetchPlaylist, 10 * 60 * 1000);

// ---- Shared playback clock ----
let state = { trackIndex: 0, trackStartedAt: Date.now() };

function currentElapsedSeconds() {
  return Math.floor((Date.now() - state.trackStartedAt) / 1000);
}

function scheduleNextTrack() {
  if (playlist.length === 0) {
    setTimeout(scheduleNextTrack, 5000); // playlist not loaded yet, check again soon
    return;
  }
  const track = playlist[state.trackIndex % playlist.length];
  const msLeft = track.durationSeconds * 1000 - (Date.now() - state.trackStartedAt);

  setTimeout(() => {
    state.trackIndex = (state.trackIndex + 1) % playlist.length;
    state.trackStartedAt = Date.now();
    io.emit("sync", {
      trackIndex: state.trackIndex,
      elapsed: 0,
      videoId: playlist[state.trackIndex].videoId,
    });
    scheduleNextTrack();
  }, Math.max(msLeft, 1000));
}
scheduleNextTrack();

// ---- Live user count ----
let userCount = 0;

io.on("connection", (socket) => {
  userCount++;
  io.emit("userCount", userCount);

  if (playlist.length > 0) {
    socket.emit("sync", {
      trackIndex: state.trackIndex,
      elapsed: currentElapsedSeconds(),
      videoId: playlist[state.trackIndex % playlist.length].videoId,
    });
  }

  socket.on("disconnect", () => {
    userCount--;
    io.emit("userCount", userCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
