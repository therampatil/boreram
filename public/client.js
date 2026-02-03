const socket = io();

// DOM Elements
const joinScreen = document.getElementById("join-screen");
const gameScreen = document.getElementById("game-screen");
const joinForm = document.getElementById("join-form");
const errorMsg = document.getElementById("error-msg");
const displayRoom = document.getElementById("display-room");
const displayName = document.getElementById("display-name");
const statusLog = document.getElementById("status-log");
const membersList = document.getElementById("members");
const shareBtn = document.getElementById("share-btn");

// Check for room code in URL params on page load
(function checkUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get("room");
  if (roomFromUrl) {
    document.getElementById("room-code").value = roomFromUrl.toUpperCase();
  }
})();

// Handle form submission
joinForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const roomCode = document
    .getElementById("room-code")
    .value.trim()
    .toUpperCase();
  const name = document.getElementById("name").value.trim();

  if (!roomCode || !name) {
    errorMsg.textContent = "> error: all fields required";
    return;
  }

  socket.emit("join-room", { roomCode, name });
});

// Successfully joined room
socket.on("joined", (data) => {
  // Switch screens
  joinScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");

  // Update display
  displayRoom.textContent = data.roomCode;
  displayName.textContent = data.name;

  // Update members list
  updateMembers(data.members);

  addLog(`> joined room [${data.roomCode}]`);

  // Update URL with room code (without reloading)
  const newUrl = `${window.location.origin}${window.location.pathname}?room=${data.roomCode}`;
  window.history.replaceState({}, "", newUrl);

  // Initialize and start the game with socket and player info
  const canvas = document.getElementById("game-canvas");
  if (canvas && typeof Game !== "undefined") {
    Game.init(canvas, socket, data.playerId, data.playerColor);
    Game.start();
    addLog("> game started. use arrow keys or A/D to move");
    addLog("> press H to toggle stealth mode");
  }
});

// Another user joined
socket.on("user-joined", (data) => {
  addLog(`> ${data.name} connected`);
  updateMembers(data.members);
});

// User left
socket.on("user-left", (data) => {
  addLog(`> ${data.name} disconnected`);
  updateMembers(data.members);
});

// Error handling
socket.on("error", (msg) => {
  errorMsg.textContent = `> error: ${msg}`;
});

// Helper: Add log entry
function addLog(message) {
  const p = document.createElement("p");
  p.classList.add("event");
  p.textContent = message;
  statusLog.appendChild(p);
  statusLog.scrollTop = statusLog.scrollHeight;
}

// Helper: Update members list
function updateMembers(members) {
  membersList.innerHTML = "";
  members.forEach((member) => {
    const li = document.createElement("li");
    li.textContent = member.name;
    membersList.appendChild(li);
  });
}

// Share button functionality
if (shareBtn) {
  shareBtn.addEventListener("click", () => {
    const roomCode = displayRoom.textContent;
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;

    navigator.clipboard
      .writeText(shareUrl)
      .then(() => {
        const originalText = shareBtn.textContent;
        shareBtn.textContent = "[Copied!]";
        shareBtn.classList.add("copied");

        setTimeout(() => {
          shareBtn.textContent = originalText;
          shareBtn.classList.remove("copied");
        }, 2000);
      })
      .catch(() => {
        // Fallback for older browsers
        const textArea = document.createElement("textarea");
        textArea.value = shareUrl;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);

        shareBtn.textContent = "[Copied!]";
        setTimeout(() => {
          shareBtn.textContent = "[Share Link]";
        }, 2000);
      });
  });
}
