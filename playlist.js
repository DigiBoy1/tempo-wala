// playlist.js — config file. Fill these in.

// 1. Your free YouTube API key
const YOUTUBE_API_KEY = "AIzaSyBDUyq1Czy7owFPmdGRwEuT8J7NN50VSTY";

// 2. Admin password (you already chose this)
const ADMIN_PASSWORD = "160610#";

// 3. Up to 5 playlists. "main" plays by default when the site starts.
//    For each one: paste the playlist ID (from youtube.com/playlist?list=XXXX)
//    Give each a friendly "name" — that's what shows as a button in the admin panel.
//    You can leave unused ones as empty string "" — they just won't show a button.
const PLAYLISTS = [
  { key: "main",  name: "Main Radio",  playlistId: "PLxzEzcNbKPvrz9s7dPxdrVKjj4cv0LWbm" },
  { key: "list2", name: "Playlist 2",  playlistId: "RDCLAK5uy_mxqgyPRK9n6mflkAhpQAXpebl2Y9E4atM" },
  { key: "list3", name: "Playlist 3",  playlistId: "PLxzEzcNbKPvq2kZynKOOzH0nTYVziw8Db" },
  { key: "list4", name: "Playlist 4",  playlistId: "RDCLAK5uy_kCFyity-5xsBCaEQbpfJz8Gxp0zz6eRQ8" },
  { key: "list5", name: "Playlist 5",  playlistId: "RDCLAK5uy_mkXiaMATud8GJQ3aX7f0nCeCqvehA9wTQ" },
];

module.exports = { YOUTUBE_API_KEY, ADMIN_PASSWORD, PLAYLISTS };