import express from "express";
import mongoose from "mongoose";
import passport from "passport";
import bcrypt from "bcryptjs";
import session from "express-session";
import { Strategy as LocalStrategy } from "passport-local";
import dotenv from "dotenv";
import flash from "connect-flash";
import { Server } from "socket.io";
import { createServer } from "http";
import formatMessage from "./public/utils/messages.js";
import {
  userJoin,
  getCurrentUser,
  getRoomUsers,
  userLeave,
} from "./public/utils/users.js";
const app = express();
const server = createServer(app);
const io = new Server(server);

dotenv.config();

const botName = "ChatCord Bot";
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", ["./views", "./client/workspace"]);

app.use(
  session({
    secret: process.env.SECRET_KEY,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

app.use(flash());

app.use(passport.initialize());
app.use(passport.session());

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ username, room }) => {
    const user = userJoin(socket.id, username, room);

    socket.join(user.room);

    socket.emit("message", formatMessage(botName, "Welcome to ChatCord"));

    socket.broadcast
      .to(user.room)
      .emit(
        "message",
        formatMessage(botName, `${user.username} has joined the chat`)
      );

    io.to(user.room).emit("roomUsers", {
      room: user.room,
      users: getRoomUsers(user.room),
    });
  });

  socket.on("disconnect", () => {
    const user = userLeave(socket.id);
    if (user) {
      io.to(user.room).emit("message", `${user.username} has left the chat`);
    }
  });

  socket.on("chatMessage", (msg) => {
    const user = getCurrentUser(socket.id);
    io.to(user.room).emit("message", formatMessage(user.username, msg));
  });
});

// Mongoose connection
try {
  await mongoose.connect("mongodb://localhost:27017/users", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("MongoDB connected");
} catch (err) {
  console.error("MongoDB connection error:", err);
}

// User model
const User = mongoose.model(
  "users",
  new mongoose.Schema({
    username: { type: String, unique: true },
    password: String,
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace" },
  })
);

passport.use(
  new LocalStrategy(async (username, password, done) => {
    try {
      const user = await User.findOne({ username: username });
      if (!user) {
        return done(null, false, { message: "Incorrect username." });
      }
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (isPasswordValid) {
        return done(null, user);
      } else {
        return done(null, false, { message: "Incorrect password." });
      }
    } catch (error) {
      return done(error);
    }
  })
);

passport.serializeUser((user, done) => {
  done(null, { id: user.id, username: user.username });
});

passport.deserializeUser(async (userData, done) => {
  try {
    const user = await User.findById(userData.id);
    done(null, user);
  } catch (error) {
    done(error);
  }
});

// Routes
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/login", (req, res) => {
  res.render("login", { errorMessage: null });
});

app.post(
  "/login",
  passport.authenticate("local", {
    successRedirect: "/workspace", // Redirect to workspace if authentication succeeds
    failureRedirect: "/login", // Redirect to login page if authentication fails
    failureFlash: true, // Enable flash messages for displaying error messages
  })
);

app.get("/signup", (req, res) => {
  res.render("signup", { errorMessage: null });
});

app.post("/signup", async (req, res) => {
  try {
    const existingUser = await User.findOne({ username: req.body.username });
    if (existingUser) {
      res.render("signup", { errorMessage: "Username already exists." });
    } else {
      const hashedPassword = await bcrypt.hash(req.body.password, 10);
      const user = new User({
        username: req.body.username,
        password: hashedPassword,
      });
      await user.save();
      res.redirect("/login");
    }
  } catch (error) {
    console.error(error);
    res.render("signup", {
      errorMessage: "An error occurred during signup. Please try again.",
    });
  }
});

app.get("/workspace", (req, res) => {
  if (req.isAuthenticated()) {
    req.flash("success", "Form submitted successfully!");
    res.render("dashboard", { user: req.user });
  } else {
    req.flash("error", "Validation failed. Please check your inputs.");
    res.redirect("/login");
  }
});

app.get("/logout", (req, res) => {
  req.logout();
  res.redirect("/");
});

app.get("/joinChatRoom", (req, res) => {
  // Redirect to the chat.html page within the "public" directory
  res.redirect("/chatcode.html");
});

const PORT = process.env.PORT || 3000; // Use environment variable or default to 3001

server.listen(PORT, () => {
  console.log("Running");
});
