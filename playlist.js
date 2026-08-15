// playlist.js — config file. Fill these in.

// 1. Your free YouTube API key
const YOUTUBE_API_KEY = "AIzaSyBDUyq1Czy7owFPmdGRwEuT8J7NN5OVSTY";

// 2. Admin password (you already chose this)
const ADMIN_PASSWORD = "160610#";

// 3. Up to 5 playlists. "main" plays by default when the site starts.
//    For each one: paste the playlist ID (from youtube.com/playlist?list=XXXX)
//    Give each a friendly "name" — that's what shows as a button in the admin panel.
//    You can leave unused ones as empty string "" — they just won't show a button.
const PLAYLISTS = [
  { key: "main",  name: "Mood-romantic",  playlistId: "PLxzEzcNbKPvrz9s7dPxdrVKjj4cv0LWbm" },
  { key: "main6",  name: "bhojpuri 6",  playlistId: "PLK_nHcQFSPbE" },
  { key: "list2", name: " bhoothnath",  playlistId: "PLGuZiHGXiIdg" },
  { key: "list3", name: "mood-haryanvi",  playlistId: "PLXl73k5eV9kE" },
  { key: "list5", name: "mood 5 ",  playlistId: "PLxzEzcNbKPvq2kZynKOOzH0nTYVziw8Db" },
  { key: "list6", name: "bhakti",  playlistId: "PLSOiXgZ_T7o8" },
  { key: "list7", name: "bus 8",  playlistId: "PLxzEzcNbKPvqQDSwKF9ou632MMucDOyv2" },
  { key: "list8", name: "Playlist 9",  playlistId: "PLTqEOF_NFMhw" },
  { key: "list9", name: "free",  playlistId: "PLJjZJoUdCWHU" },
  { key: "list4", name: "bairan",  playlistId: "PLTgmeJQIet5A" },
];

module.exports = { YOUTUBE_API_KEY, ADMIN_PASSWORD, PLAYLISTS };