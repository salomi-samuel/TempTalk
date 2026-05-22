require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2");
const multer = require("multer");
const fs = require("fs");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static("public"));

// 🔥 MYSQL
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

// 🔥 USERS
let users = {};

// ✅ BROADCAST ONLINE USERS
function broadcastOnlineUsers(room) {
    const usersInRoom = Object.values(users)
        .filter(u => u.room === room)
        .map(u => u.username);

    io.to(room).emit("onlineUsers", usersInRoom);
}

// 🔥 CREATE deleted_for TABLE
db.query(`
    CREATE TABLE IF NOT EXISTS deleted_for (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id INT NOT NULL,
        username VARCHAR(255) NOT NULL,
        UNIQUE KEY unique_delete (message_id, username)
    )
`, (err) => {
    if (err) console.log("❌ CREATE TABLE ERROR:", err);
    else console.log("✅ deleted_for table ready");
});

// 🔥 S3
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_KEY
    }
});

function getS3Key(url) {
    try {
        // get raw pathname and decode %20 back to spaces
        const pathname = new URL(url).pathname.slice(1);
        return decodeURIComponent(pathname);
    } catch {
        return null;
    }
}

// ================= SOCKET =================
io.on("connection", (socket) => {
    console.log("✅ User connected:", socket.id);

    // ✅ TYPING
    socket.on("typing", ({ username, room, isTyping }) => {
        socket.to(room).emit("typingUpdate", { username, isTyping });
    });

    // ✅ JOIN ROOM
    socket.on("joinRoom", ({ username, room }) => {
        socket.join(room);
        users[socket.id] = { username, room };

        console.log("JOIN:", username, room);

        // 🔥 LOAD OLD MESSAGES (skip deleted-for-user)
        db.query(
            `SELECT m.* FROM messages m
             WHERE m.room = ?
             AND m.id NOT IN (
                 SELECT message_id FROM deleted_for WHERE username = ?
             )
             ORDER BY m.id ASC`,
            [room, username],
            (err, results) => {
                if (err) {
                    console.log("❌ FETCH ERROR:", err);
                    return;
                }

                results.forEach((msg) => {
                    socket.emit("message", {
                        id: msg.id,
                        username: msg.username,
                        message: msg.message,
                        time: msg.created_at
                    });
                });
            }
        );

        socket.to(room).emit("message", {
            id: null,
            username: "System",
            message: username + " joined"
        });

        // ✅ UPDATE ONLINE USERS
        broadcastOnlineUsers(room);
    });

    // ✅ SEND MESSAGE
    socket.on("chatMessage", (msg) => {
        const user = users[socket.id];
        if (!user) return;

        db.query(
            "INSERT INTO messages (room, username, message) VALUES (?, ?, ?)",
            [user.room, user.username, msg],
            (err, result) => {
                if (err) {
                    console.log("❌ DB ERROR:", err);
                } else {
                    const msgId = result.insertId;

                    io.to(user.room).emit("message", {
                        id: msgId,
                        username: user.username,
                        message: msg,
                        time: new Date().toISOString() // ✅ timestamp
                    });
                }
            }
        );
    });

    // ✅ DELETE MESSAGE
    socket.on("deleteMessage", ({ msgId, deleteFor }) => {
        const user = users[socket.id];
        if (!user) return;

        if (deleteFor === "everyone") {

            db.query(
                "SELECT * FROM messages WHERE id = ? AND username = ?",
                [msgId, user.username],
                async (err, results) => {
                    if (err || results.length === 0) {
                        console.log("❌ NOT YOUR MESSAGE");
                        return;
                    }

                    const msg = results[0];

                    // 🔥 DELETE FROM S3 IF IMAGE
                    const isS3 = msg.message &&
                        msg.message.startsWith("https://") &&
                        msg.message.includes("temptalk-files-123");

                    if (isS3) {
                        const key = getS3Key(msg.message);
                        if (key) {
    console.log("🔑 Deleting S3 key:", key); // add this
    try {
        await s3.send(new DeleteObjectCommand({
                                    Bucket: "temptalk-files-123",
                                    Key: key
                                }));
                                console.log("✅ S3 DELETED:", key);
                            } catch (e) {
                                console.log("❌ S3 ERROR:", e);
                            }
                        }
                    }

                    // 🔥 DELETE FROM DB
                    db.query("DELETE FROM messages WHERE id = ?", [msgId], (err2) => {
                        if (err2) {
                            console.log("❌ DELETE ERROR:", err2);
                        } else {
                            db.query("DELETE FROM deleted_for WHERE message_id = ?", [msgId]);
                            io.to(user.room).emit("messageDeleted", msgId);
                        }
                    });
                }
            );

        } else {
            // 🔥 DELETE FOR ME
            db.query(
                "INSERT IGNORE INTO deleted_for (message_id, username) VALUES (?, ?)",
                [msgId, user.username],
                (err) => {
                    if (err) {
                        console.log("❌ DELETE_FOR ERROR:", err);
                    } else {
                        socket.emit("messageDeleted", msgId);
                    }
                }
            );
        }
    });

    // ✅ DISCONNECT
    socket.on("disconnect", () => {
        const user = users[socket.id];

        if (user) {
            io.to(user.room).emit("message", {
                id: null,
                username: "System",
                message: user.username + " left"
            });

            delete users[socket.id];

            // ✅ UPDATE USERS
            broadcastOnlineUsers(user.room);
        }

        console.log("❌ User disconnected:", socket.id);
    });

});

// ================= FILE UPLOAD =================
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        const fileStream = fs.createReadStream(file.path);
        const fileName = Date.now() + "-" + file.originalname;

        await s3.send(new PutObjectCommand({
            Bucket: "temptalk-files-123",
            Key: fileName,
            Body: fileStream,
            ContentType: file.mimetype
        }));

        fs.unlinkSync(file.path);

        const url = `https://temptalk-files-123.s3.eu-north-1.amazonaws.com/${fileName}`;;

        res.json({ url });

    } catch (err) {
        console.log("❌ UPLOAD ERROR:", err);
        res.status(500).send("error");
    }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("🚀 Running on " + PORT);
});