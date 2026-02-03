/**
 * Neon Racer - Multiplayer Browser Racing Game
 * @created by therampatil
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));

// Track rooms and users with game state
const rooms = {};

// Race states
const RACE_STATE = {
  WAITING: "waiting", // Waiting for players to join
  COUNTDOWN: "countdown", // 3-2-1-GO countdown
  RACING: "racing", // Race in progress
  PAUSED: "paused", // Race paused by host
  FINISHED: "finished", // Race completed
};

// Race settings
const MIN_PLAYERS_TO_START = 2; // Minimum players needed to start
const DEFAULT_RACE_DISTANCE = 1000; // Default meters to finish line
const COUNTDOWN_SECONDS = 3;

// Game state structure for each room
// rooms[roomCode] = {
//   members: [{ id, name }],
//   players: { [socketId]: { name, x, worldY, distance, color, stunned, finished, finishTime, position } },
//   obstacles: [{ id, x, worldY, distance }],
//   nextObstacleId: 0,
//   lastSpawnWorldY: 0,
//   creatorId: socketId,
//   raceState: 'waiting' | 'countdown' | 'racing' | 'finished',
//   raceStartTime: null,
//   countdownStartTime: null,
//   finishOrder: []
// }

// Obstacle generation settings
const OBSTACLE_SPAWN_INTERVAL = 50; // meters between obstacles
const OBSTACLE_DESPAWN_DISTANCE = 100; // meters behind the last player
const SPAWN_AHEAD_DISTANCE = 300; // meters ahead of furthest player to spawn
const PIXELS_PER_METER = 2; // Must match client

// Dynamic difficulty settings
const BASE_ROAD_WIDTH = 200;
const MAX_ROAD_WIDTH = 400;
const ROAD_EXPANSION_INTERVAL = 30000; // 30 seconds
const ROAD_EXPANSION_RATE = 1.1; // 10% increase

const BASE_GAME_SPEED = 2;
const MAX_GAME_SPEED = 20; // Chaos mode speed
const SPEED_INCREMENT_PER_TICK = 0.0005;

// Colors for other players
const playerColors = [
  "#ff6b6b",
  "#4ecdc4",
  "#ffe66d",
  "#95e1d3",
  "#f38181",
  "#aa96da",
  "#fcbad3",
  "#a8d8ea",
];

function getPlayerColor(index) {
  return playerColors[index % playerColors.length];
}

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Handle join room request
  socket.on("join-room", (data) => {
    const { roomCode, name } = data;

    if (!roomCode || !name) {
      socket.emit("error", "Room code and name are required");
      return;
    }

    // Join the Socket.io room
    socket.join(roomCode);

    // Store user info
    socket.roomCode = roomCode;
    socket.userName = name;

    // Check if this is a new room (user is creator)
    const isNewRoom = !rooms[roomCode];

    // Initialize room if needed
    if (isNewRoom) {
      rooms[roomCode] = {
        members: [],
        players: {},
        obstacles: [],
        nextObstacleId: 0,
        lastSpawnWorldY: 0,
        furthestWorldY: 0,
        // Dynamic difficulty state
        roadWidth: BASE_ROAD_WIDTH,
        gameSpeed: BASE_GAME_SPEED,
        lastExpansionTime: Date.now(),
        createdAt: Date.now(),
        creatorId: socket.id,
        // Race state
        raceState: RACE_STATE.WAITING,
        raceStartTime: null,
        countdownStartTime: null,
        countdownValue: 0,
        finishOrder: [],
        raceDistance: DEFAULT_RACE_DISTANCE,
        pausedAt: null, // Track when race was paused
      };
    }

    // Check if race already started - late joiners rejected
    const room = rooms[roomCode];
    if (
      room.raceState === RACE_STATE.RACING ||
      room.raceState === RACE_STATE.COUNTDOWN ||
      room.raceState === RACE_STATE.PAUSED
    ) {
      socket.emit("error", "Race already in progress. Wait for it to finish.");
      socket.leave(roomCode);
      return;
    }

    // Add to members list
    rooms[roomCode].members.push({ id: socket.id, name: name });

    // Calculate starting grid position (staggered rows)
    const playerIndex = rooms[roomCode].members.length - 1;
    const gridRow = Math.floor(playerIndex / 2); // 2 cars per row
    const gridCol = playerIndex % 2; // Left or right side

    // X position: alternate left (0.3) and right (0.7) of road
    const startX = gridCol === 0 ? 0.35 : 0.65;
    // Y position: stagger rows back from start line
    const startWorldY = gridRow * 60; // Each row 60 pixels behind

    // Initialize player game state
    rooms[roomCode].players[socket.id] = {
      name: name,
      x: startX, // Grid position
      startX: startX, // Remember starting X for reset
      worldY: startWorldY, // Staggered start position
      startWorldY: startWorldY, // Remember for reset
      distance: 0,
      color: getPlayerColor(playerIndex),
      stunned: false,
      stunnedUntil: 0,
      finished: false,
      finishTime: null,
      position: null,
      gridPosition: playerIndex + 1, // 1-based grid position
    };

    // Check if we have enough players to start
    const playerCount = Object.keys(rooms[roomCode].players).length;
    const canStart = playerCount >= MIN_PLAYERS_TO_START;

    console.log(
      `User [${name}] joined Room [${roomCode}]${isNewRoom ? " (creator)" : ""} (${playerCount} players)`,
    );

    // Notify the user they joined successfully
    socket.emit("joined", {
      roomCode: roomCode,
      name: name,
      members: rooms[roomCode].members,
      playerId: socket.id,
      playerColor: rooms[roomCode].players[socket.id].color,
      isCreator: rooms[roomCode].creatorId === socket.id,
      spawnWorldY: 0,
      raceState: rooms[roomCode].raceState,
      raceDistance: rooms[roomCode].raceDistance,
      canStart: canStart,
      minPlayers: MIN_PLAYERS_TO_START,
      playerCount: playerCount,
    });

    // Notify others in the room about new player and updated player count
    socket.to(roomCode).emit("user-joined", {
      name: name,
      members: rooms[roomCode].members,
      playerCount: playerCount,
      canStart: canStart,
    });
  });

  // Handle SET RACE DISTANCE request (only creator, only in waiting state)
  socket.on("set-race-distance", (data) => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];

    // Only creator can set distance
    if (room.creatorId !== socket.id) {
      socket.emit("error", "Only the room creator can set race distance");
      return;
    }

    // Only in waiting state
    if (room.raceState !== RACE_STATE.WAITING) {
      socket.emit("error", "Can only set distance before race starts");
      return;
    }

    const distance = parseInt(data.distance) || DEFAULT_RACE_DISTANCE;
    room.raceDistance = Math.max(100, Math.min(10000, distance)); // Clamp between 100-10000m

    console.log(
      `Room [${roomCode}] race distance set to ${room.raceDistance}m`,
    );

    // Notify all players
    io.to(roomCode).emit("race-distance-changed", {
      distance: room.raceDistance,
    });
  });

  // Handle START RACE request (only creator can start)
  socket.on("start-race", () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];

    // Only creator can start
    if (room.creatorId !== socket.id) {
      socket.emit("error", "Only the room creator can start the race");
      return;
    }

    // Check minimum players
    const playerCount = Object.keys(room.players).length;
    if (playerCount < MIN_PLAYERS_TO_START) {
      socket.emit(
        "error",
        `Need at least ${MIN_PLAYERS_TO_START} players to start`,
      );
      return;
    }

    // Check if already started
    if (room.raceState !== RACE_STATE.WAITING) {
      socket.emit("error", "Race already started");
      return;
    }

    // Start countdown
    room.raceState = RACE_STATE.COUNTDOWN;
    room.countdownStartTime = Date.now();
    room.countdownValue = COUNTDOWN_SECONDS;

    console.log(`Room [${roomCode}] starting countdown...`);

    // Notify all players
    io.to(roomCode).emit("race-countdown", {
      countdown: COUNTDOWN_SECONDS,
      message: "Race starting!",
    });
  });

  // Handle PAUSE/RESUME race (only creator)
  socket.on("toggle-pause", () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];

    // Only creator can pause
    if (room.creatorId !== socket.id) {
      socket.emit("error", "Only the room creator can pause the race");
      return;
    }

    if (room.raceState === RACE_STATE.RACING) {
      // Pause the race
      room.raceState = RACE_STATE.PAUSED;
      room.pausedAt = Date.now();
      console.log(`Room [${roomCode}] race paused`);
      io.to(roomCode).emit("race-paused", { message: "Race paused by host" });
    } else if (room.raceState === RACE_STATE.PAUSED) {
      // Resume the race
      const pauseDuration = Date.now() - room.pausedAt;
      room.raceStartTime += pauseDuration; // Adjust start time to account for pause
      room.raceState = RACE_STATE.RACING;
      room.pausedAt = null;
      console.log(`Room [${roomCode}] race resumed`);
      io.to(roomCode).emit("race-resumed", { message: "Race resumed!" });
    }
  });

  // Handle player state updates from clients
  socket.on("player-update", (data) => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode] && rooms[roomCode].players[socket.id]) {
      const room = rooms[roomCode];
      const player = room.players[socket.id];

      // Only allow movement during racing state
      if (room.raceState === RACE_STATE.RACING && !player.finished) {
        player.x = data.x;
        player.worldY = data.worldY !== undefined ? data.worldY : player.worldY;
        player.distance = data.distance;
        player.stunned = data.stunned || false;

        // Check if player crossed finish line
        if (player.distance >= room.raceDistance && !player.finished) {
          player.finished = true;
          player.finishTime = Date.now() - room.raceStartTime;
          room.finishOrder.push(socket.id);
          player.position = room.finishOrder.length;

          console.log(
            `Player [${player.name}] finished in position ${player.position}!`,
          );

          // Notify all players
          io.to(roomCode).emit("player-finished", {
            name: player.name,
            position: player.position,
            time: player.finishTime,
          });

          // Check if all players finished
          const allFinished = Object.values(room.players).every(
            (p) => p.finished,
          );
          if (allFinished) {
            room.raceState = RACE_STATE.FINISHED;
            io.to(roomCode).emit("race-finished", {
              results: room.finishOrder.map((id, index) => ({
                position: index + 1,
                name: room.players[id].name,
                time: room.players[id].finishTime,
              })),
            });
          }
        }
      }
    }
  });

  // Handle restart game request (only creator can restart)
  socket.on("restart-game", () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];

    // Only the creator can restart
    if (room.creatorId !== socket.id) {
      socket.emit("error", "Only the room creator can restart the game");
      return;
    }

    // Reset all players to starting grid position
    let playerIndex = 0;
    for (const playerId in room.players) {
      const player = room.players[playerId];

      // Calculate grid position (same logic as joining)
      const gridRow = Math.floor(playerIndex / 2);
      const gridCol = playerIndex % 2;
      const startX = gridCol === 0 ? 0.35 : 0.65;
      const startWorldY = gridRow * 60;

      player.worldY = startWorldY;
      player.startWorldY = startWorldY;
      player.distance = 0;
      player.x = startX;
      player.startX = startX;
      player.stunned = false;
      player.stunnedUntil = 0;
      player.finished = false;
      player.finishTime = null;
      player.position = null;
      player.gridPosition = playerIndex + 1;

      playerIndex++;
    }

    // Clear obstacles
    room.obstacles = [];
    room.nextObstacleId = 0;
    room.lastSpawnWorldY = 0;
    room.furthestWorldY = 0;

    // Reset difficulty
    room.roadWidth = BASE_ROAD_WIDTH;
    room.gameSpeed = BASE_GAME_SPEED;
    room.lastExpansionTime = Date.now();

    // Reset race state
    room.raceState = RACE_STATE.WAITING;
    room.raceStartTime = null;
    room.countdownStartTime = null;
    room.countdownValue = 0;
    room.finishOrder = [];

    const playerCount = Object.keys(room.players).length;
    const canStart = playerCount >= MIN_PLAYERS_TO_START;

    console.log(`Room [${roomCode}] restarted by creator`);

    // Notify all players in the room
    io.to(roomCode).emit("game-restarted", {
      message: "Game restarted by host!",
      raceState: room.raceState,
      canStart: canStart,
      playerCount: playerCount,
    });
  });

  // Handle collision report from client
  socket.on("collision", () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode] && rooms[roomCode].players[socket.id]) {
      const player = rooms[roomCode].players[socket.id];
      player.stunned = true;
      player.stunnedUntil = Date.now() + 2000; // 2 seconds stun
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      // Remove from members
      rooms[socket.roomCode].members = rooms[socket.roomCode].members.filter(
        (user) => user.id !== socket.id,
      );

      // Remove player state
      delete rooms[socket.roomCode].players[socket.id];

      console.log(`User [${socket.userName}] left Room [${socket.roomCode}]`);

      // Notify others in the room
      io.to(socket.roomCode).emit("user-left", {
        name: socket.userName,
        members: rooms[socket.roomCode].members,
      });

      // Clean up empty rooms
      if (rooms[socket.roomCode].members.length === 0) {
        delete rooms[socket.roomCode];
      }
    }
  });
});

// Game state broadcast loop - 30 TPS (ticks per second)
const TICK_RATE = 30;
setInterval(() => {
  const now = Date.now();

  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    if (room.members.length > 0) {
      // Handle countdown state
      if (room.raceState === RACE_STATE.COUNTDOWN) {
        const elapsed = now - room.countdownStartTime;
        const newCountdown = COUNTDOWN_SECONDS - Math.floor(elapsed / 1000);

        if (newCountdown !== room.countdownValue && newCountdown >= 0) {
          room.countdownValue = newCountdown;
          io.to(roomCode).emit("race-countdown", {
            countdown: newCountdown,
            message: newCountdown > 0 ? newCountdown.toString() : "GO!",
          });
        }

        // Countdown finished - start race!
        if (elapsed >= COUNTDOWN_SECONDS * 1000) {
          room.raceState = RACE_STATE.RACING;
          room.raceStartTime = now;
          room.gameSpeed = BASE_GAME_SPEED;
          console.log(`Room [${roomCode}] race started!`);
          io.to(roomCode).emit("race-started", {
            raceDistance: room.raceDistance,
            startTime: room.raceStartTime,
          });
        }
      }

      // Only update game state during racing
      if (room.raceState === RACE_STATE.RACING) {
        // Update stun states
        for (const playerId in room.players) {
          const player = room.players[playerId];
          if (player.stunned && now >= player.stunnedUntil) {
            player.stunned = false;
          }
        }

        // Dynamic difficulty: Increase game speed slowly each tick
        if (room.gameSpeed < MAX_GAME_SPEED) {
          room.gameSpeed += SPEED_INCREMENT_PER_TICK;
          room.gameSpeed = Math.min(room.gameSpeed, MAX_GAME_SPEED);
        }

        // Dynamic difficulty: Expand road every 30 seconds
        if (now - room.lastExpansionTime >= ROAD_EXPANSION_INTERVAL) {
          room.lastExpansionTime = now;
          const newWidth = room.roadWidth * ROAD_EXPANSION_RATE;
          room.roadWidth = Math.min(newWidth, MAX_ROAD_WIDTH);
          console.log(
            `Room [${roomCode}] road expanded to ${Math.floor(room.roadWidth)}px`,
          );
        }
      }

      // Find player positions in world Y coordinates
      // worldY is negative and decreases (more negative) as players move forward
      // So: smaller worldY = further ahead, larger worldY = further behind
      let minWorldY = 0; // Most negative = furthest ahead (leader)
      let maxWorldY = 0; // Least negative = furthest behind
      let hasPlayers = false;

      for (const odplayerId in room.players) {
        const p = room.players[odplayerId];
        const wy = p.worldY || 0;

        if (!hasPlayers) {
          minWorldY = wy;
          maxWorldY = wy;
          hasPlayers = true;
        } else {
          if (wy < minWorldY) minWorldY = wy; // More negative = further ahead
          if (wy > maxWorldY) maxWorldY = wy; // Less negative = further behind
        }
      }

      // Only spawn obstacles during racing state
      if (room.raceState === RACE_STATE.RACING) {
        // Generate new obstacles ahead of the leading player
        // Obstacles spawn at negative worldY values ahead of the leader
        const spawnAheadPixels = SPAWN_AHEAD_DISTANCE * PIXELS_PER_METER;
        const spawnIntervalPixels = OBSTACLE_SPAWN_INTERVAL * PIXELS_PER_METER;

        // Initialize spawn position if needed (start spawning ahead of current leader)
        if (room.lastSpawnWorldY === 0 && hasPlayers) {
          room.lastSpawnWorldY = minWorldY - spawnIntervalPixels;
        }

        // Spawn obstacles ahead of the leading player (minWorldY)
        // We need lastSpawnWorldY to be more negative than minWorldY - spawnAhead
        const spawnThreshold = minWorldY - spawnAheadPixels;
        while (room.lastSpawnWorldY > spawnThreshold) {
          room.lastSpawnWorldY -= spawnIntervalPixels;

          // Distribute obstacles across the FULL road width including edges
          let obstacleX;
          const zoneRoll = Math.random();
          if (zoneRoll < 0.25) {
            // Left edge zone (0.02 - 0.25)
            obstacleX = Math.random() * 0.23 + 0.02;
          } else if (zoneRoll < 0.5) {
            // Right edge zone (0.75 - 0.98)
            obstacleX = Math.random() * 0.23 + 0.75;
          } else {
            // Center zone (0.25 - 0.75)
            obstacleX = Math.random() * 0.5 + 0.25;
          }

          const newObstacle = {
            id: room.nextObstacleId++,
            x: obstacleX,
            worldY: room.lastSpawnWorldY,
            distance: Math.abs(room.lastSpawnWorldY) / PIXELS_PER_METER,
          };
          room.obstacles.push(newObstacle);
        }

        // Remove obstacles that are behind all players (worldY greater than maxWorldY + buffer)
        const despawnBufferPixels =
          OBSTACLE_DESPAWN_DISTANCE * PIXELS_PER_METER;
        room.obstacles = room.obstacles.filter(
          (obs) => obs.worldY < maxWorldY + despawnBufferPixels,
        );
      }

      // Build leaderboard (top 5 by distance)
      const leaderboard = Object.entries(room.players)
        .map(([id, p]) => ({
          name: p.name,
          distance: p.distance,
          finished: p.finished,
          position: p.position,
        }))
        .sort((a, b) => {
          // Finished players first, by position
          if (a.finished && !b.finished) return -1;
          if (!a.finished && b.finished) return 1;
          if (a.finished && b.finished) return a.position - b.position;
          // Then by distance
          return b.distance - a.distance;
        })
        .slice(0, 5);

      // Broadcast game state
      io.to(roomCode).emit("game-state", {
        players: room.players,
        obstacles: room.obstacles,
        leaderboard: leaderboard,
        roadWidth: room.roadWidth,
        gameSpeed: room.raceState === RACE_STATE.RACING ? room.gameSpeed : 0,
        raceState: room.raceState,
        raceDistance: room.raceDistance,
        raceTime: room.raceStartTime ? now - room.raceStartTime : 0,
      });
    }
  }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
