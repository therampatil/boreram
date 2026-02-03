/**
 * Neon Racer - Client Socket Handler
 * @created by therampatil
 */

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
const restartBtn = document.getElementById("restart-btn");
const startRaceBtn = document.getElementById("start-race-btn");
const lobbyMessage = document.getElementById("lobby-message");
const lobbyStatus = document.getElementById("lobby-status");
const pauseBtn = document.getElementById("pause-btn");
const newRoomBtn = document.getElementById("new-room-btn");
const distanceSelector = document.getElementById("distance-selector");
const raceDistanceSelect = document.getElementById("race-distance-select");

// Track game state
let isCreator = false;
let raceState = "waiting";
let minPlayers = 2;
let canStart = false;

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

  // Store race info
  raceState = data.raceState || "waiting";
  minPlayers = data.minPlayers || 2;
  canStart = data.canStart || false;

  // Update stats display
  updateRaceInfo(data.playerCount, data.raceDistance);

  // Check if user is the room creator
  isCreator = data.isCreator || false;
  if (isCreator) {
    addLog("> you are the host. you can start the race.");
    if (canStart && raceState === "waiting") {
      startRaceBtn.classList.remove("hidden");
    }
    // Show distance selector for host
    if (distanceSelector && raceState === "waiting") {
      distanceSelector.classList.remove("hidden");
    }
  }

  // Update URL with room code (without reloading)
  const newUrl = `${window.location.origin}${window.location.pathname}?room=${data.roomCode}`;
  window.history.replaceState({}, "", newUrl);

  // Initialize the game (but don't start racing yet)
  const canvas = document.getElementById("game-canvas");
  if (canvas && typeof Game !== "undefined") {
    Game.init(
      canvas,
      socket,
      data.playerId,
      data.playerColor,
      0,
      data.raceDistance,
    );
    Game.start();
    addLog("> waiting for race to start...");
    addLog("> press H to toggle stealth mode");
  }
});

// Another user joined
socket.on("user-joined", (data) => {
  addLog(`> ${data.name} connected`);
  updateMembers(data.members);

  // Update can start status
  canStart = data.canStart;
  if (isCreator && canStart && raceState === "waiting") {
    startRaceBtn.classList.remove("hidden");
    addLog("> enough players! you can start the race now.");
  }

  updatePlayerCount(data.playerCount);
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

// Handle game restart from server
socket.on("game-restarted", (data) => {
  addLog(`> ${data.message}`);
  raceState = data.raceState || "waiting";
  canStart = data.canStart;

  // Show/hide buttons
  if (isCreator && canStart && raceState === "waiting") {
    startRaceBtn.classList.remove("hidden");
    restartBtn.classList.add("hidden");
  }

  // Hide pause button on restart
  if (pauseBtn) {
    pauseBtn.classList.add("hidden");
  }

  // Show distance selector for host
  if (isCreator && distanceSelector) {
    distanceSelector.classList.remove("hidden");
  }

  // Show lobby message
  if (lobbyMessage) {
    lobbyMessage.classList.remove("hidden");
  }

  // Reset game
  if (typeof Game !== "undefined") {
    Game.reset();
  }

  updatePlayerCount(data.playerCount);
});

// Handle race countdown
socket.on("race-countdown", (data) => {
  raceState = "countdown";
  startRaceBtn.classList.add("hidden");

  if (lobbyMessage) {
    lobbyMessage.classList.add("hidden");
  }

  addLog(`> ${data.message}`);

  if (typeof Game !== "undefined") {
    Game.showCountdown(data.countdown);
  }
});

// Handle race started
socket.on("race-started", (data) => {
  raceState = "racing";
  addLog("> GO! Race started!");
  addLog("> use arrow keys or A/D to move, W/↑ to boost");

  // Show pause button for host during race
  if (isCreator && pauseBtn) {
    pauseBtn.classList.remove("hidden");
    pauseBtn.textContent = "[Pause]";
  }

  // Hide distance selector
  if (distanceSelector) {
    distanceSelector.classList.add("hidden");
  }

  if (typeof Game !== "undefined") {
    Game.startRacing(data.raceDistance);
  }
});

// Handle player finished
socket.on("player-finished", (data) => {
  const timeStr = formatTime(data.time);
  addLog(`> ${data.name} finished ${getOrdinal(data.position)}! (${timeStr})`);

  if (typeof Game !== "undefined") {
    Game.playerFinished(data);
  }
});

// Handle race finished
socket.on("race-finished", (data) => {
  raceState = "finished";
  addLog("> === RACE FINISHED ===");

  data.results.forEach((r) => {
    const timeStr = formatTime(r.time);
    addLog(`> ${getOrdinal(r.position)}: ${r.name} - ${timeStr}`);
  });

  // Hide pause button
  if (pauseBtn) {
    pauseBtn.classList.add("hidden");
  }

  if (isCreator) {
    restartBtn.classList.remove("hidden");
    addLog("> click [New Race] to race again!");
  }

  if (typeof Game !== "undefined") {
    Game.showResults(data.results);
  }
});

// Handle race paused
socket.on("race-paused", (data) => {
  raceState = "paused";
  addLog(`> ${data.message}`);

  // Show pause button as Resume for host
  if (isCreator && pauseBtn) {
    pauseBtn.textContent = "[Resume]";
  }

  if (typeof Game !== "undefined" && Game.setPaused) {
    Game.setPaused(true);
  }
});

// Handle race resumed
socket.on("race-resumed", (data) => {
  raceState = "racing";
  addLog(`> ${data.message}`);

  // Show pause button as Pause for host
  if (isCreator && pauseBtn) {
    pauseBtn.textContent = "[Pause]";
  }

  if (typeof Game !== "undefined" && Game.setPaused) {
    Game.setPaused(false);
  }
});

// Handle race distance changed
socket.on("race-distance-changed", (data) => {
  addLog(`> race distance set to ${data.distance}m`);

  // Update UI
  const statFinish = document.getElementById("stat-finish");
  if (statFinish) statFinish.textContent = data.distance + "m";

  if (typeof Game !== "undefined" && Game.setRaceDistance) {
    Game.setRaceDistance(data.distance);
  }
});

// Start race button
if (startRaceBtn) {
  startRaceBtn.addEventListener("click", () => {
    if (!isCreator || !canStart) return;
    socket.emit("start-race");
    startRaceBtn.classList.add("hidden");
    addLog("> starting race...");
  });
}

// Restart button functionality (only visible to creator after race)
if (restartBtn) {
  restartBtn.addEventListener("click", () => {
    if (!isCreator) return;

    socket.emit("restart-game");
    restartBtn.classList.add("hidden");
    addLog("> setting up new race...");
  });
}

// Pause button functionality (only for creator during race)
if (pauseBtn) {
  pauseBtn.addEventListener("click", () => {
    if (!isCreator) return;
    socket.emit("toggle-pause");
  });
}

// New room button functionality
if (newRoomBtn) {
  newRoomBtn.addEventListener("click", () => {
    // Go back to join screen with a fresh state
    gameScreen.classList.add("hidden");
    joinScreen.classList.remove("hidden");

    // Clear the room code input to encourage a new room
    document.getElementById("room-code").value = "";

    // Clear URL params
    window.history.replaceState({}, "", window.location.pathname);

    // Reset state
    isCreator = false;
    raceState = "waiting";
    canStart = false;

    // Clear status log
    statusLog.innerHTML = "<p>> Ready to join a new room...</p>";

    // Hide all buttons
    startRaceBtn.classList.add("hidden");
    restartBtn.classList.add("hidden");
    if (pauseBtn) pauseBtn.classList.add("hidden");
    if (distanceSelector) distanceSelector.classList.add("hidden");

    // Clear error message
    errorMsg.textContent = "";
  });
}

// Distance selector (host only)
if (raceDistanceSelect) {
  raceDistanceSelect.addEventListener("change", (e) => {
    if (!isCreator) return;
    const distance = parseInt(e.target.value);
    socket.emit("set-race-distance", { distance });
  });
}

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

// Helper: Format time in mm:ss.ms
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor((ms % 1000) / 10);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`;
}

// Helper: Get ordinal suffix (1st, 2nd, 3rd, etc.)
function getOrdinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Helper: Update race info display
function updateRaceInfo(playerCount, raceDistance) {
  const statPlayers = document.getElementById("stat-players");
  const statMinPlayers = document.getElementById("stat-min-players");
  const statFinish = document.getElementById("stat-finish");
  const statStatus = document.getElementById("stat-status");

  if (statPlayers) statPlayers.textContent = playerCount || 0;
  if (statMinPlayers) statMinPlayers.textContent = minPlayers;
  if (statFinish) statFinish.textContent = (raceDistance || 1000) + "m";
  if (statStatus) statStatus.textContent = "Waiting";

  // Update lobby status
  if (lobbyStatus) {
    if (playerCount >= minPlayers) {
      lobbyStatus.textContent = "> Ready to race!";
    } else {
      lobbyStatus.textContent = `> Need ${minPlayers - playerCount} more player(s)`;
    }
  }
}

// Helper: Update player count
function updatePlayerCount(count) {
  const statPlayers = document.getElementById("stat-players");
  if (statPlayers) statPlayers.textContent = count || 0;

  // Update lobby status
  if (lobbyStatus) {
    if (count >= minPlayers) {
      lobbyStatus.textContent = "> Ready to race!";
    } else {
      lobbyStatus.textContent = `> Need ${minPlayers - count} more player(s)`;
    }
  }
}

// New room button (available to everyone)
if (newRoomBtn) {
  newRoomBtn.addEventListener("click", () => {
    // Go back to join screen with a fresh state
    gameScreen.classList.add("hidden");
    joinScreen.classList.remove("hidden");

    // Generate a new room code
    const newRoomCode = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();
    document.getElementById("room-code").value = newRoomCode;

    // Clear URL params
    window.history.replaceState({}, "", window.location.pathname);

    // Reset state
    isCreator = false;
    raceState = "waiting";
    canStart = false;

    // Clear status log
    statusLog.innerHTML = "<p>> Ready to join a new room...</p>";

    // Hide all buttons
    startRaceBtn.classList.add("hidden");
    restartBtn.classList.add("hidden");
    if (pauseBtn) pauseBtn.classList.add("hidden");
    if (distanceSelector) distanceSelector.classList.add("hidden");

    // Clear error message
    errorMsg.textContent = "";

    addLog(`> new room code: ${newRoomCode}`);
  });
}

// Pause button (host only)
if (pauseBtn) {
  pauseBtn.addEventListener("click", () => {
    if (!isCreator) return;
    if (raceState !== "racing" && raceState !== "paused") return;

    // Send toggle-pause to server - server handles the state
    socket.emit("toggle-pause");
  });
}
