/**
 * Neon Racer - Game Engine
 * @created by therampatil
 */

// Game Engine - Infinite Road with World Coordinates
const Game = (function () {
  let canvas, ctx;
  let gameRunning = false;
  let stealthMode = false;
  let socket = null;
  let playerId = null;

  // Camera system - follows player in world coordinates
  const camera = {
    y: 0, // World Y position of camera
    targetY: 0, // For smooth following
    lerpSpeed: 0.1, // How smoothly camera follows
  };

  // Road properties
  const road = {
    width: 200,
    targetWidth: 200, // For smooth lerping
    color: "#2c2c2c",
    lineColor: "#00ddff", // Neon blue
    lineWidth: 4,
    lineHeight: 40,
    lineGap: 30,
    rumbleWidth: 10,
    rumbleHeight: 20,
  };

  // Neon glow settings
  const NEON_BLUE = "#00ddff";
  const NEON_RED = "#ff2222";
  const NEON_GLOW_BLUR = 15;

  // Lerp settings for smooth transitions
  const ROAD_LERP_SPEED = 0.02; // How fast the road width transitions

  // Asphalt noise cache (generated once for performance)
  let asphaltNoisePattern = null;

  // Player (car) properties - now with world coordinates
  const player = {
    width: 30,
    height: 50,
    color: "#33ff33",
    x: 0, // Screen X position
    worldY: 0, // Absolute world Y position (grows indefinitely)
    speed: 5,
    distance: 0, // Distance traveled in meters
  };

  // Pixels per meter conversion
  const PIXELS_PER_METER = 2;

  // Other players from server
  let otherPlayers = {};
  let obstacles = [];
  let leaderboard = [];
  const MAX_RENDER_DISTANCE = 500; // meters

  // Screen position where player car is rendered (near bottom)
  const PLAYER_SCREEN_Y_OFFSET = 100; // pixels from bottom

  // Road texture height for seamless tiling
  const ROAD_TEXTURE_HEIGHT = 100;

  // Stun state
  let isStunned = false;
  let stunnedUntil = 0;
  const STUN_DURATION = 2000; // 2 seconds

  // Game state
  let scrollSpeed = 2;
  let serverSpeed = 2; // Speed from server
  const baseSpeed = 2;
  const maxSpeed = 20; // Match server's chaos mode speed
  const speedIncrement = 0.001;

  // Input state
  const keys = {
    left: false,
    right: false,
    boost: false,
  };

  // Boost settings
  const BOOST_MULTIPLIER = 1.5;
  let isBoosting = false;

  // Boost animation particles
  let boostParticles = [];

  // Race state
  let raceState = "waiting"; // waiting, countdown, racing, paused, finished
  let raceDistance = 1000; // meters to finish
  let countdownValue = 0;
  let raceTime = 0;
  let finalRaceTime = 0; // Time when race ended (for display)
  let playerFinishedData = null;
  let raceResults = null;
  let myPosition = null;
  let myFinished = false; // Track if THIS player has finished

  // Initialize the game
  function init(
    canvasElement,
    socketInstance,
    id,
    color,
    spawnWorldY = 0,
    distance = 1000,
  ) {
    canvas = canvasElement;
    ctx = canvas.getContext("2d");
    raceDistance = distance;
    socket = socketInstance;
    playerId = id;

    // Set player color if provided
    if (color) {
      player.color = color;
    }

    // Set canvas size
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Initialize player position (screen X centered, world Y at spawn position)
    player.x = canvas.width / 2 - player.width / 2;
    player.worldY = spawnWorldY || 0;
    player.distance = Math.abs(player.worldY) / PIXELS_PER_METER;

    // Initialize camera to follow player (offset so player appears near bottom)
    const initialCameraY =
      player.worldY - (canvas.height - player.height - PLAYER_SCREEN_Y_OFFSET);
    camera.y = initialCameraY;
    camera.targetY = initialCameraY;

    // Clear boost particles
    boostParticles = [];

    // Setup input listeners
    setupInputListeners();

    // Setup socket listeners for game state
    setupSocketListeners();

    console.log("Game initialized at worldY:", spawnWorldY);
  }

  // Reset game state (called when host restarts)
  function reset() {
    player.x = canvas.width / 2 - player.width / 2;
    player.worldY = 0;
    player.distance = 0;

    const initialCameraY =
      player.worldY - (canvas.height - player.height - PLAYER_SCREEN_Y_OFFSET);
    camera.y = initialCameraY;
    camera.targetY = initialCameraY;

    scrollSpeed = 0;
    serverSpeed = 0;
    isStunned = false;
    isBoosting = false;
    boostParticles = [];
    obstacles = [];

    // Reset race state
    raceState = "waiting";
    countdownValue = 0;
    raceTime = 0;
    finalRaceTime = 0;
    playerFinishedData = null;
    raceResults = null;
    myPosition = null;
    myFinished = false;

    console.log("Game reset");
  }

  // Called when countdown starts
  function showCountdown(value) {
    raceState = "countdown";
    countdownValue = value;
  }

  // Called when race starts
  function startRacing(distance) {
    raceState = "racing";
    raceDistance = distance || 1000;
    countdownValue = 0;
  }

  // Called when a player finishes
  function playerFinished(data) {
    if (data.name === (otherPlayers[playerId]?.name || "You")) {
      myPosition = data.position;
      myFinished = true; // This player has finished - stop their movement
    }
  }

  // Called when race ends
  function showResults(results) {
    raceState = "finished";
    raceResults = results;
    finalRaceTime = raceTime; // Freeze the time display
  }

  // Called when race is paused/resumed
  function setPaused(isPaused) {
    if (isPaused) {
      raceState = "paused";
    } else {
      raceState = "racing";
    }
  }

  // Called when race distance is changed (before race starts)
  function setRaceDistance(distance) {
    raceDistance = distance || 1000;
  }

  function setupSocketListeners() {
    if (!socket) return;

    socket.on("game-state", (data) => {
      otherPlayers = data.players;
      obstacles = data.obstacles || [];
      leaderboard = data.leaderboard || [];

      // Update target road width for smooth lerping
      if (data.roadWidth && data.roadWidth !== road.targetWidth) {
        road.targetWidth = data.roadWidth;
      }

      // Update server-controlled speed (0 when not racing)
      serverSpeed = data.gameSpeed || 0;

      // Update race state from server
      if (data.raceState) {
        raceState = data.raceState;
      }
      if (data.raceDistance) {
        raceDistance = data.raceDistance;
      }
      if (data.raceTime) {
        raceTime = data.raceTime;
      }
    });
  }

  function resizeCanvas() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    // Recenter player X position
    player.x = canvas.width / 2 - player.width / 2;

    // Regenerate asphalt noise pattern on resize
    generateAsphaltNoise();
  }

  // Generate asphalt texture pattern
  function generateAsphaltNoise() {
    const patternCanvas = document.createElement("canvas");
    patternCanvas.width = road.width;
    patternCanvas.height = 100;
    const patternCtx = patternCanvas.getContext("2d");

    // Base asphalt color
    patternCtx.fillStyle = road.color;
    patternCtx.fillRect(0, 0, patternCanvas.width, patternCanvas.height);

    // Add random noise specs
    for (let i = 0; i < 200; i++) {
      const x = Math.random() * patternCanvas.width;
      const y = Math.random() * patternCanvas.height;
      const shade =
        Math.random() > 0.5
          ? `rgba(60, 60, 60, ${Math.random() * 0.5})`
          : `rgba(30, 30, 30, ${Math.random() * 0.5})`;
      patternCtx.fillStyle = shade;
      patternCtx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }

    asphaltNoisePattern = ctx.createPattern(patternCanvas, "repeat");
  }

  function setupInputListeners() {
    document.addEventListener("keydown", (e) => {
      switch (e.key.toLowerCase()) {
        case "arrowleft":
        case "a":
          keys.left = true;
          e.preventDefault();
          break;
        case "arrowright":
        case "d":
          keys.right = true;
          e.preventDefault();
          break;
        case "arrowup":
        case "w":
          keys.boost = true;
          e.preventDefault();
          break;
        case "h":
          toggleStealthMode();
          e.preventDefault();
          break;
      }
    });

    document.addEventListener("keyup", (e) => {
      switch (e.key.toLowerCase()) {
        case "arrowleft":
        case "a":
          keys.left = false;
          break;
        case "arrowright":
        case "d":
          keys.right = false;
          break;
        case "arrowup":
        case "w":
          keys.boost = false;
          break;
      }
    });
  }

  function toggleStealthMode() {
    stealthMode = !stealthMode;
    const overlay = document.getElementById("stealth-overlay");
    if (overlay) {
      overlay.classList.toggle("hidden", !stealthMode);
    }
  }

  function start() {
    if (gameRunning) return;
    gameRunning = true;
    scrollSpeed = 0; // Don't move until race starts
    gameLoop();
    console.log("Game started (waiting for race)");
  }

  function stop() {
    gameRunning = false;
  }

  function update() {
    const now = Date.now();

    // Only allow movement during racing state AND if player hasn't finished
    const canMove = raceState === "racing" && !myFinished;

    // Check if stun has expired
    if (isStunned && now >= stunnedUntil) {
      isStunned = false;
      scrollSpeed = serverSpeed;
    }

    // Smoothly lerp road width towards target
    if (Math.abs(road.width - road.targetWidth) > 0.5) {
      road.width += (road.targetWidth - road.width) * ROAD_LERP_SPEED;
      // Regenerate asphalt pattern if width changed significantly
      if (Math.abs(road.width - road.targetWidth) < 1) {
        generateAsphaltNoise();
      }
    }

    // Sync scroll speed with server (with slight local smoothing)
    if (!isStunned && canMove) {
      scrollSpeed += (serverSpeed - scrollSpeed) * 0.1;

      // Apply boost if holding up arrow/W
      isBoosting = keys.boost && !isStunned && canMove;

      // Generate boost particles when boosting
      if (isBoosting) {
        // Add new particles from the back of the car
        const playerScreenY =
          canvas.height - player.height - PLAYER_SCREEN_Y_OFFSET;
        for (let i = 0; i < 2; i++) {
          boostParticles.push({
            x: player.x + player.width / 2 + (Math.random() - 0.5) * 10,
            y: playerScreenY + player.height,
            vx: (Math.random() - 0.5) * 2,
            vy: 3 + Math.random() * 3,
            life: 1.0,
            size: 3 + Math.random() * 4,
            color: Math.random() > 0.5 ? "#ff6600" : "#ffaa00",
          });
        }
      }
    } else if (!canMove) {
      scrollSpeed = 0;
      isBoosting = false;
    }

    // Update boost particles
    boostParticles = boostParticles.filter((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.05;
      p.size *= 0.95;
      return p.life > 0;
    });

    // Calculate effective speed with boost
    const effectiveSpeed = isBoosting
      ? scrollSpeed * BOOST_MULTIPLIER
      : scrollSpeed;

    // Update world position - only if not stunned AND racing
    if (!isStunned && canMove) {
      // Move player forward in world Y (negative = moving up/forward)
      player.worldY -= effectiveSpeed * PIXELS_PER_METER;

      // Update distance traveled (convert scroll speed to meters)
      player.distance += effectiveSpeed * 0.1;
    }

    // Update camera to follow player
    // Camera.y should be set so that player.worldY appears at PLAYER_SCREEN_Y_OFFSET from bottom
    // screenY = worldY - camera.y, and we want screenY = canvas.height - player.height - PLAYER_SCREEN_Y_OFFSET
    // So: camera.y = player.worldY - (canvas.height - player.height - PLAYER_SCREEN_Y_OFFSET)
    camera.targetY =
      player.worldY - (canvas.height - player.height - PLAYER_SCREEN_Y_OFFSET);
    camera.y += (camera.targetY - camera.y) * camera.lerpSpeed;

    // Update stats display in left panel
    updateStatsDisplay();

    // Update player X position (horizontal movement)
    const roadLeft = canvas.width / 2 - road.width / 2;
    const roadRight = canvas.width / 2 + road.width / 2;

    if (keys.left) {
      player.x -= player.speed;
    }
    if (keys.right) {
      player.x += player.speed;
    }

    // Keep player within road bounds
    if (player.x < roadLeft) {
      player.x = roadLeft;
    }
    if (player.x + player.width > roadRight) {
      player.x = roadRight - player.width;
    }

    // Check collision with obstacles
    if (!isStunned) {
      checkObstacleCollisions(roadLeft);
    }

    // Send player state to server
    sendPlayerUpdate();
  }

  // Update the stats display in the left panel
  function updateStatsDisplay() {
    const speedEl = document.getElementById("stat-speed");
    const distanceEl = document.getElementById("stat-distance");
    const playersEl = document.getElementById("stat-players");
    const timeEl = document.getElementById("stat-time");
    const statusEl = document.getElementById("stat-status");

    if (speedEl) {
      const displaySpeed = isBoosting
        ? scrollSpeed * BOOST_MULTIPLIER
        : scrollSpeed;
      speedEl.textContent = displaySpeed.toFixed(1) + (isBoosting ? " 🚀" : "");
    }
    if (distanceEl) {
      const remaining = Math.max(0, raceDistance - Math.floor(player.distance));
      distanceEl.textContent = `${Math.floor(player.distance)}m / ${raceDistance}m`;
    }
    if (playersEl) {
      playersEl.textContent = Object.keys(otherPlayers).length;
    }
    if (timeEl) {
      // Show final time when race is finished, otherwise show current time
      const displayTime = raceState === "finished" ? finalRaceTime : raceTime;
      if (displayTime > 0) {
        timeEl.textContent = formatRaceTime(displayTime);
      }
    }
    if (statusEl) {
      const states = {
        waiting: "Waiting",
        countdown: "Starting...",
        racing: "Racing!",
        paused: "Paused",
        finished: "Finished",
      };
      statusEl.textContent = states[raceState] || "Waiting";
    }
  }

  function checkObstacleCollisions(roadLeft) {
    const obstacleSize = 25;

    // Player's screen Y position (fixed near bottom)
    const playerScreenY =
      canvas.height - player.height - PLAYER_SCREEN_Y_OFFSET;

    for (const obs of obstacles) {
      // Use worldY directly if available from server, otherwise calculate from distance
      const obsWorldY =
        obs.worldY !== undefined
          ? obs.worldY
          : -obs.distance * PIXELS_PER_METER;

      // Convert to screen position using helper
      const obsScreenY = toScreenY(obsWorldY);
      const obsX = roadLeft + obs.x * (road.width - obstacleSize);

      // Check if within collision range
      const distY = Math.abs(obsScreenY - playerScreenY);
      if (distY > 50) continue;

      // Simple AABB collision
      if (
        player.x < obsX + obstacleSize &&
        player.x + player.width > obsX &&
        playerScreenY < obsScreenY + obstacleSize &&
        playerScreenY + player.height > obsScreenY
      ) {
        // Collision detected!
        triggerStun();
        break;
      }
    }
  }

  function triggerStun() {
    if (isStunned) return; // Already stunned

    isStunned = true;
    stunnedUntil = Date.now() + STUN_DURATION;
    scrollSpeed = 0; // Stop the car

    // Notify server of collision
    if (socket) {
      socket.emit("collision");
    }
  }

  function sendPlayerUpdate() {
    if (!socket) return;

    const roadLeft = canvas.width / 2 - road.width / 2;
    const roadRight = canvas.width / 2 + road.width / 2;

    // Normalize X position (0-1 within road bounds)
    const normalizedX =
      (player.x - roadLeft) / (roadRight - roadLeft - player.width);

    socket.emit("player-update", {
      x: normalizedX,
      worldY: player.worldY,
      distance: player.distance,
      stunned: isStunned,
    });
  }

  // ============================================
  // RENDERING HELPERS - World to Screen conversion
  // ============================================

  /**
   * Convert world Y coordinate to screen Y coordinate
   * @param {number} worldY - The world Y position
   * @returns {number} - The screen Y position
   */
  function toScreenY(worldY) {
    return worldY - camera.y;
  }

  /**
   * Check if a world Y position is visible on screen
   * @param {number} worldY - The world Y position
   * @param {number} objectHeight - Height of the object (for bounds check)
   * @returns {boolean} - True if visible on screen
   */
  function isOnScreen(worldY, objectHeight = 0) {
    const screenY = toScreenY(worldY);
    return screenY > -objectHeight && screenY < canvas.height + objectHeight;
  }

  function draw() {
    // Clear canvas
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const roadX = canvas.width / 2 - road.width / 2;

    // Draw road background with seamless scrolling texture
    drawRoadBackground(roadX);

    // Draw rumble strips (red and white alternating) on both edges
    drawRumbleStrips(roadX);

    // Draw road edges
    ctx.strokeStyle = "#555555";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(roadX, 0);
    ctx.lineTo(roadX, canvas.height);
    ctx.moveTo(roadX + road.width, 0);
    ctx.lineTo(roadX + road.width, canvas.height);
    ctx.stroke();

    // Draw center lane markers with neon blue glow (world coordinates)
    drawNeonRoadLines(roadX);

    // Draw start line
    drawStartLine(roadX);

    // Draw finish line
    drawFinishLine(roadX);

    // Draw speed lines when going fast (>80% of max speed) or boosting
    const effectiveSpeed = isBoosting
      ? scrollSpeed * BOOST_MULTIPLIER
      : scrollSpeed;
    const speedPercent = (effectiveSpeed - baseSpeed) / (maxSpeed - baseSpeed);
    if (speedPercent > 0.6 || isBoosting) {
      drawSpeedLines(
        Math.min(1, isBoosting ? speedPercent + 0.3 : speedPercent),
      );
    }

    // Draw obstacles with neon red glow
    drawObstacles(roadX);

    // Draw other players (ghost mechanic)
    drawOtherPlayers(roadX);

    // Player's screen Y position (fixed near bottom of view)
    const playerScreenY =
      canvas.height - player.height - PLAYER_SCREEN_Y_OFFSET;

    // Draw boost particles (flames behind car)
    if (boostParticles.length > 0) {
      drawBoostParticles();
    }

    // Draw player car with detailed design
    const playerName = otherPlayers[playerId]?.name || "You";
    drawCar(
      player.x,
      playerScreenY,
      player.width,
      player.height,
      player.color,
      playerName,
      isStunned,
      isBoosting,
    );

    // Draw stun indicator on canvas
    if (isStunned) {
      ctx.fillStyle = "#ff3333";
      ctx.font = '16px "Courier New", monospace';
      const stunRemaining = Math.max(
        0,
        Math.ceil((stunnedUntil - Date.now()) / 1000),
      );
      ctx.textAlign = "center";
      ctx.fillText(`STUNNED! ${stunRemaining}s`, canvas.width / 2, 30);
      ctx.textAlign = "left";
    }

    // Draw boost indicator
    if (isBoosting && !isStunned) {
      ctx.fillStyle = "#ffdd00";
      ctx.font = '14px "Courier New", monospace';
      ctx.textAlign = "center";
      ctx.fillText("🚀 BOOST!", canvas.width / 2, canvas.height - 20);
      ctx.textAlign = "left";
    }

    // Draw leaderboard
    drawLeaderboard();

    // Draw race overlays (countdown, waiting, results)
    drawRaceOverlay();
  }

  // Draw start line (at worldY = 0)
  function drawStartLine(roadX) {
    const startWorldY = 0;
    if (!isOnScreen(startWorldY, 20)) return;

    const screenY = toScreenY(startWorldY);

    // Checkered pattern
    ctx.save();
    const squareSize = 10;
    const numSquares = Math.ceil(road.width / squareSize);

    for (let i = 0; i < numSquares; i++) {
      for (let row = 0; row < 2; row++) {
        const isWhite = (i + row) % 2 === 0;
        ctx.fillStyle = isWhite ? "#ffffff" : "#000000";
        ctx.fillRect(
          roadX + i * squareSize,
          screenY - squareSize + row * squareSize,
          squareSize,
          squareSize,
        );
      }
    }

    // "START" text
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.fillStyle = "#00ff00";
    ctx.textAlign = "center";
    ctx.shadowBlur = 10;
    ctx.shadowColor = "#00ff00";
    ctx.fillText("START", canvas.width / 2, screenY - 25);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // Draw finish line
  function drawFinishLine(roadX) {
    const finishWorldY = -raceDistance * PIXELS_PER_METER;
    if (!isOnScreen(finishWorldY, 20)) return;

    const screenY = toScreenY(finishWorldY);

    // Checkered pattern
    ctx.save();
    const squareSize = 10;
    const numSquares = Math.ceil(road.width / squareSize);

    for (let i = 0; i < numSquares; i++) {
      for (let row = 0; row < 2; row++) {
        const isWhite = (i + row) % 2 === 0;
        ctx.fillStyle = isWhite ? "#ffffff" : "#000000";
        ctx.fillRect(
          roadX + i * squareSize,
          screenY - squareSize + row * squareSize,
          squareSize,
          squareSize,
        );
      }
    }

    // "FINISH" text with glow
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.fillStyle = "#ffdd00";
    ctx.textAlign = "center";
    ctx.shadowBlur = 15;
    ctx.shadowColor = "#ffdd00";
    ctx.fillText("🏁 FINISH 🏁", canvas.width / 2, screenY - 25);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // Draw race overlays (countdown, waiting screen, results)
  function drawRaceOverlay() {
    ctx.save();
    ctx.textAlign = "center";

    if (raceState === "waiting") {
      // Waiting for race to start
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      ctx.fillRect(canvas.width / 2 - 150, canvas.height / 2 - 60, 300, 120);

      ctx.font = 'bold 24px "Courier New", monospace';
      ctx.fillStyle = "#33ff33";
      ctx.fillText(
        "WAITING FOR PLAYERS",
        canvas.width / 2,
        canvas.height / 2 - 20,
      );

      ctx.font = '14px "Courier New", monospace';
      ctx.fillStyle = "#888888";
      ctx.fillText(
        "Host will start the race",
        canvas.width / 2,
        canvas.height / 2 + 20,
      );
    }

    if (raceState === "countdown" && countdownValue >= 0) {
      // Countdown overlay
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.font = 'bold 120px "Courier New", monospace';
      ctx.shadowBlur = 30;

      if (countdownValue > 0) {
        ctx.fillStyle = "#ffdd00";
        ctx.shadowColor = "#ffdd00";
        ctx.fillText(
          countdownValue.toString(),
          canvas.width / 2,
          canvas.height / 2 + 40,
        );
      } else {
        ctx.fillStyle = "#00ff00";
        ctx.shadowColor = "#00ff00";
        ctx.fillText("GO!", canvas.width / 2, canvas.height / 2 + 40);
      }
      ctx.shadowBlur = 0;
    }

    // Paused overlay
    if (raceState === "paused") {
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.font = 'bold 60px "Courier New", monospace';
      ctx.fillStyle = "#ffe66d";
      ctx.shadowBlur = 20;
      ctx.shadowColor = "#ffe66d";
      ctx.fillText("PAUSED", canvas.width / 2, canvas.height / 2 - 20);
      ctx.shadowBlur = 0;

      ctx.font = '16px "Courier New", monospace';
      ctx.fillStyle = "#888888";
      ctx.fillText(
        "Host will resume the race",
        canvas.width / 2,
        canvas.height / 2 + 30,
      );
    }

    if (raceState === "finished" && raceResults) {
      // Results overlay
      ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
      ctx.fillRect(canvas.width / 2 - 180, 50, 360, 300);

      ctx.font = 'bold 28px "Courier New", monospace';
      ctx.fillStyle = "#ffdd00";
      ctx.shadowBlur = 10;
      ctx.shadowColor = "#ffdd00";
      ctx.fillText("🏆 RACE COMPLETE 🏆", canvas.width / 2, 100);
      ctx.shadowBlur = 0;

      ctx.font = '16px "Courier New", monospace';
      raceResults.forEach((r, index) => {
        const y = 140 + index * 30;
        const medal =
          index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "  ";
        const timeStr = formatRaceTime(r.time);

        ctx.fillStyle =
          r.name === otherPlayers[playerId]?.name ? "#33ff33" : "#ffffff";
        ctx.fillText(
          `${medal} ${getOrdinal(r.position)} - ${r.name} (${timeStr})`,
          canvas.width / 2,
          y,
        );
      });

      ctx.font = '12px "Courier New", monospace';
      ctx.fillStyle = "#888888";
      ctx.fillText("Host can start a new race", canvas.width / 2, 320);
    }

    // Show position when player finishes
    if (myPosition && raceState === "racing") {
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      ctx.fillRect(canvas.width / 2 - 100, 60, 200, 50);

      ctx.font = 'bold 20px "Courier New", monospace';
      ctx.fillStyle = "#33ff33";
      ctx.fillText(
        `You finished ${getOrdinal(myPosition)}!`,
        canvas.width / 2,
        95,
      );
    }

    ctx.restore();
  }

  // Helper functions for race overlay
  function formatRaceTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const millis = Math.floor((ms % 1000) / 10);
    return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`;
  }

  function getOrdinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Draw the road background with seamless scrolling using modulus
  function drawRoadBackground(roadX) {
    // Use modulus to create seamless scrolling effect
    // camera.y is negative as player moves forward, so we use Math.abs
    const textureOffset =
      ((camera.y % ROAD_TEXTURE_HEIGHT) + ROAD_TEXTURE_HEIGHT) %
      ROAD_TEXTURE_HEIGHT;

    if (asphaltNoisePattern) {
      ctx.save();
      ctx.fillStyle = asphaltNoisePattern;
      // Translate to create the scrolling effect
      ctx.translate(0, textureOffset);
      // Draw road slightly larger to cover the offset
      ctx.fillRect(
        roadX,
        -ROAD_TEXTURE_HEIGHT,
        road.width,
        canvas.height + ROAD_TEXTURE_HEIGHT * 2,
      );
      ctx.restore();
    } else {
      ctx.fillStyle = road.color;
      ctx.fillRect(roadX, 0, road.width, canvas.height);
    }
  }

  // Draw neon blue road lines using world coordinates
  function drawNeonRoadLines(roadX) {
    const lineSpacing = road.lineHeight + road.lineGap;
    const centerX = canvas.width / 2 - road.lineWidth / 2;

    // Calculate which lines are visible based on camera position
    // We need to find world Y positions that map to screen 0 to canvas.height
    // screenY = worldY - camera.y, so worldY = screenY + camera.y
    const topWorldY = camera.y; // World Y at top of screen
    const bottomWorldY = camera.y + canvas.height; // World Y at bottom of screen

    const startLine = Math.floor(topWorldY / lineSpacing) - 1;
    const endLine = Math.ceil(bottomWorldY / lineSpacing) + 1;

    // Enable neon glow
    ctx.shadowBlur = NEON_GLOW_BLUR;
    ctx.shadowColor = NEON_BLUE;
    ctx.fillStyle = NEON_BLUE;

    for (let i = startLine; i <= endLine; i++) {
      const worldY = i * lineSpacing;
      const screenY = toScreenY(worldY);

      // Skip if off screen
      if (screenY < -road.lineHeight || screenY > canvas.height) continue;

      ctx.fillRect(centerX, screenY, road.lineWidth, road.lineHeight);
    }

    // Reset glow
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }

  // Draw rumble strips on road edges using world coordinates
  function drawRumbleStrips(roadX) {
    const rumbleW = road.rumbleWidth;
    const rumbleH = road.rumbleHeight;

    // Calculate visible world Y range
    const topWorldY = camera.y;
    const bottomWorldY = camera.y + canvas.height;

    const startSegment = Math.floor(topWorldY / rumbleH) - 1;
    const endSegment = Math.ceil(bottomWorldY / rumbleH) + 1;

    for (let i = startSegment; i <= endSegment; i++) {
      const worldY = i * rumbleH;
      const screenY = toScreenY(worldY);

      // Skip if off screen
      if (screenY < -rumbleH || screenY > canvas.height) continue;

      const isRed = i % 2 === 0;
      ctx.fillStyle = isRed ? "#cc0000" : "#ffffff";

      // Left rumble strip
      ctx.fillRect(roadX - rumbleW, screenY, rumbleW, rumbleH);

      // Right rumble strip
      ctx.fillRect(roadX + road.width, screenY, rumbleW, rumbleH);
    }

    // Add slight shadow/depth to rumble strips
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fillRect(roadX - rumbleW, 0, 2, canvas.height);
    ctx.fillRect(roadX + road.width + rumbleW - 2, 0, 2, canvas.height);
  }

  // Draw speed lines for motion blur effect
  function drawSpeedLines(speedPercent) {
    const intensity = (speedPercent - 0.8) / 0.2; // 0 to 1 when speed is 80-100%
    const alpha = intensity * 0.4;
    const lineCount = Math.floor(5 + intensity * 10);

    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 1 + intensity;

    // Left side speed lines
    for (let i = 0; i < lineCount; i++) {
      const x = Math.random() * 40;
      const y = Math.random() * canvas.height;
      const length = 30 + Math.random() * 50 * intensity;

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.random() * 5, y + length);
      ctx.stroke();
    }

    // Right side speed lines
    for (let i = 0; i < lineCount; i++) {
      const x = canvas.width - 40 + Math.random() * 40;
      const y = Math.random() * canvas.height;
      const length = 30 + Math.random() * 50 * intensity;

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - Math.random() * 5, y + length);
      ctx.stroke();
    }
  }

  // Draw boost flame particles behind the car
  function drawBoostParticles() {
    ctx.save();
    for (const p of boostParticles) {
      const alpha = p.life;
      ctx.globalAlpha = alpha;
      ctx.shadowBlur = 10;
      ctx.shadowColor = p.color;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawObstacles(roadX) {
    const obstacleSize = 25;

    // Enable neon red glow
    ctx.shadowBlur = NEON_GLOW_BLUR;
    ctx.shadowColor = NEON_RED;

    for (const obs of obstacles) {
      // Use worldY directly if available from server, otherwise calculate from distance
      const obsWorldY =
        obs.worldY !== undefined
          ? obs.worldY
          : -obs.distance * PIXELS_PER_METER;

      // Check if on screen using helper
      if (!isOnScreen(obsWorldY, obstacleSize)) continue;

      // Convert to screen position using helper
      const obsScreenY = toScreenY(obsWorldY);
      const obsX = roadX + obs.x * (road.width - obstacleSize);

      // Draw obstacle (neon red square with glow)
      ctx.fillStyle = NEON_RED;
      ctx.fillRect(obsX, obsScreenY, obstacleSize, obstacleSize);

      // Add inner detail (darker core)
      ctx.shadowBlur = 0; // Temporarily disable glow for inner
      ctx.fillStyle = "#990000";
      ctx.fillRect(
        obsX + 4,
        obsScreenY + 4,
        obstacleSize - 8,
        obstacleSize - 8,
      );
      ctx.shadowBlur = NEON_GLOW_BLUR; // Re-enable glow
      ctx.shadowColor = NEON_RED;
    }

    // Reset glow
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }

  function drawLeaderboard() {
    if (leaderboard.length === 0) return;

    const padding = 10;
    const lineHeight = 16;
    const boxWidth = 150;
    const boxHeight = padding * 2 + lineHeight * (leaderboard.length + 1);
    const boxX = canvas.width - boxWidth - 10;
    const boxY = 10;

    // Draw background
    ctx.fillStyle = "rgba(10, 10, 10, 0.8)";
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);

    // Draw title
    ctx.fillStyle = "#888";
    ctx.font = '11px "Courier New", monospace';
    ctx.fillText("> LEADERBOARD", boxX + padding, boxY + padding + 10);

    // Draw entries
    ctx.font = '10px "Courier New", monospace';
    leaderboard.forEach((entry, index) => {
      const yPos = boxY + padding + lineHeight * (index + 2);
      const name = entry.name.substring(0, 8).padEnd(8);
      const dist = Math.floor(entry.distance) + "m";

      // Highlight current player
      if (
        otherPlayers[playerId] &&
        entry.name === otherPlayers[playerId].name
      ) {
        ctx.fillStyle = "#33ff33";
      } else {
        ctx.fillStyle = "#666";
      }

      ctx.fillText(`${index + 1}. ${name} ${dist}`, boxX + padding, yPos);
    });
  }

  function drawOtherPlayers(roadX) {
    const roadLeft = roadX;

    for (const id in otherPlayers) {
      // Skip self
      if (id === playerId) continue;

      const other = otherPlayers[id];

      // Calculate distance difference for render culling
      const distanceDiff = other.distance - player.distance;

      // Don't render if too far apart (>500m)
      if (Math.abs(distanceDiff) > MAX_RENDER_DISTANCE) continue;

      // Use worldY if available, otherwise calculate from distance
      const otherWorldY =
        other.worldY !== undefined
          ? other.worldY
          : -other.distance * PIXELS_PER_METER;

      // Check if on screen using helper
      if (!isOnScreen(otherWorldY, player.height)) continue;

      // Convert to screen position using helper
      const otherScreenY = toScreenY(otherWorldY);

      // Calculate X position from normalized value
      const otherX = roadLeft + other.x * (road.width - player.width);

      // Draw other player car with detailed design
      drawCar(
        otherX,
        otherScreenY,
        player.width,
        player.height,
        other.color || "#ff6b6b",
        other.name,
        other.stunned,
      );
    }
  }

  // Draw a detailed sports car
  function drawCar(
    x,
    y,
    width,
    height,
    color,
    name,
    stunned = false,
    boosting = false,
  ) {
    const w = width;
    const h = height;

    // If stunned, add a flickering effect
    if (stunned && Math.floor(Date.now() / 100) % 2 === 0) {
      ctx.globalAlpha = 0.5;
    }

    // Boost glow effect around the car
    if (boosting) {
      ctx.shadowBlur = 20;
      ctx.shadowColor = "#ff6600";
      ctx.fillStyle = "rgba(255, 102, 0, 0.3)";
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w * 0.8, h * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Add shadow for 3D pop effect
    ctx.shadowBlur = boosting ? 15 : 10;
    ctx.shadowColor = boosting ? "#ff6600" : "black";
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;

    // Tires (black rectangles extending from sides)
    ctx.fillStyle = "#1a1a1a";
    const tireWidth = 5;
    const tireHeight = 10;
    // Front left tire
    ctx.fillRect(x - 2, y + 6, tireWidth, tireHeight);
    // Front right tire
    ctx.fillRect(x + w - 3, y + 6, tireWidth, tireHeight);
    // Rear left tire
    ctx.fillRect(x - 2, y + h - 16, tireWidth, tireHeight);
    // Rear right tire
    ctx.fillRect(x + w - 3, y + h - 16, tireWidth, tireHeight);

    // Car body - tapered front (aerodynamic)
    ctx.fillStyle = color;
    ctx.beginPath();
    // Start from bottom left
    ctx.moveTo(x, y + h);
    // Left side (straight)
    ctx.lineTo(x, y + h * 0.3);
    // Tapered front left
    ctx.lineTo(x + w * 0.15, y + h * 0.1);
    // Front curve
    ctx.quadraticCurveTo(x + w * 0.5, y - 2, x + w * 0.85, y + h * 0.1);
    // Tapered front right
    ctx.lineTo(x + w, y + h * 0.3);
    // Right side (straight)
    ctx.lineTo(x + w, y + h);
    // Bottom
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fill();

    // Car body darker shade (lower part)
    ctx.fillStyle = shadeColor(color, -30);
    ctx.fillRect(x + 2, y + h * 0.6, w - 4, h * 0.35);

    // Windshield (darker, angled look)
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath();
    ctx.moveTo(x + 4, y + h * 0.35);
    ctx.lineTo(x + 6, y + h * 0.18);
    ctx.lineTo(x + w - 6, y + h * 0.18);
    ctx.lineTo(x + w - 4, y + h * 0.35);
    ctx.closePath();
    ctx.fill();

    // Windshield reflection
    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    ctx.beginPath();
    ctx.moveTo(x + 6, y + h * 0.2);
    ctx.lineTo(x + 8, y + h * 0.18);
    ctx.lineTo(x + w * 0.4, y + h * 0.18);
    ctx.lineTo(x + w * 0.35, y + h * 0.25);
    ctx.closePath();
    ctx.fill();

    // Rear window
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(x + 5, y + h * 0.7, w - 10, h * 0.12);

    // Headlights (yellow circles at front)
    ctx.fillStyle = "#ffdd00";
    // Left headlight
    ctx.beginPath();
    ctx.arc(x + 7, y + h * 0.12, 3, 0, Math.PI * 2);
    ctx.fill();
    // Right headlight
    ctx.beginPath();
    ctx.arc(x + w - 7, y + h * 0.12, 3, 0, Math.PI * 2);
    ctx.fill();

    // Headlight glow effect
    ctx.fillStyle = "rgba(255, 221, 0, 0.3)";
    ctx.beginPath();
    ctx.arc(x + 7, y + h * 0.12, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + w - 7, y + h * 0.12, 5, 0, Math.PI * 2);
    ctx.fill();

    // Taillights (red rectangles at back)
    ctx.fillStyle = "#ff0000";
    // Left taillight
    ctx.fillRect(x + 3, y + h - 6, 6, 4);
    // Right taillight
    ctx.fillRect(x + w - 9, y + h - 6, 6, 4);

    // Taillight glow
    ctx.fillStyle = "rgba(255, 0, 0, 0.4)";
    ctx.fillRect(x + 1, y + h - 8, 10, 8);
    ctx.fillRect(x + w - 11, y + h - 8, 10, 8);

    // Boost exhaust flames
    if (boosting) {
      const flameTime = Date.now() / 50;
      const flameHeight = 8 + Math.sin(flameTime) * 4;

      // Left exhaust flame
      ctx.fillStyle = "#ff6600";
      ctx.beginPath();
      ctx.moveTo(x + 8, y + h);
      ctx.lineTo(x + 5, y + h + flameHeight);
      ctx.lineTo(x + 11, y + h);
      ctx.closePath();
      ctx.fill();

      // Right exhaust flame
      ctx.beginPath();
      ctx.moveTo(x + w - 8, y + h);
      ctx.lineTo(x + w - 5, y + h + flameHeight);
      ctx.lineTo(x + w - 11, y + h);
      ctx.closePath();
      ctx.fill();

      // Inner flame (brighter)
      ctx.fillStyle = "#ffaa00";
      const innerHeight = flameHeight * 0.6;
      ctx.beginPath();
      ctx.moveTo(x + 8, y + h);
      ctx.lineTo(x + 6, y + h + innerHeight);
      ctx.lineTo(x + 10, y + h);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x + w - 8, y + h);
      ctx.lineTo(x + w - 6, y + h + innerHeight);
      ctx.lineTo(x + w - 10, y + h);
      ctx.closePath();
      ctx.fill();
    }

    // Racing stripe (optional flair)
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fillRect(x + w * 0.45, y + h * 0.1, w * 0.1, h * 0.85);

    // Reset shadow and alpha
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.globalAlpha = 1;

    // Draw name tag above car
    drawNameTag(x + w / 2, y - 8, name, color);
  }

  // Draw name tag with outline for readability
  function drawNameTag(x, y, name, color) {
    ctx.font = '10px Consolas, "Courier New", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    const displayName = name.substring(0, 10);

    // Black outline/stroke for readability
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeText(displayName, x, y);

    // White fill
    ctx.fillStyle = "#ffffff";
    ctx.fillText(displayName, x, y);

    // Reset
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  // Helper: Darken or lighten a hex color
  function shadeColor(color, percent) {
    const num = parseInt(color.replace("#", ""), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.max(0, Math.min(255, (num >> 16) + amt));
    const G = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amt));
    const B = Math.max(0, Math.min(255, (num & 0x0000ff) + amt));
    return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
  }

  function gameLoop() {
    if (!gameRunning) return;

    update();
    draw();

    requestAnimationFrame(gameLoop);
  }

  // Public API
  return {
    init,
    start,
    stop,
    reset,
    showCountdown,
    startRacing,
    playerFinished,
    showResults,
    setPaused,
    setRaceDistance,
    isRunning: () => gameRunning,
  };
})();
