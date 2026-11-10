import { GAME } from "./config.js";
import { storage, todayKey } from "./utils.js";

const PROFILE_KEY = "pianogiri.profile.v1";

export const ACHIEVEMENTS = [
  { id: "first-song", title: "First Notes", text: "Finish your first song." },
  { id: "three-stars", title: "Star Pupil", text: "Earn 3 stars on any song." },
  { id: "combo-25", title: "In the Groove", text: "Reach a 25-note combo." },
  { id: "combo-100", title: "Unstoppable", text: "Reach a 100-note combo." },
  { id: "hold-master", title: "Steady Hands", text: "Complete 10 held notes in one song." },
  { id: "performer", title: "Stage Ready", text: "Finish a song in Perform mode." },
  { id: "full-piano", title: "Both Hands", text: "Finish a song on Hard difficulty." },
  { id: "converter", title: "Song Maker", text: "Turn your own audio or MIDI into a lesson." },
  { id: "streak-3", title: "Habit Forming", text: "Practise 3 days in a row." },
  { id: "streak-7", title: "Weekly Warrior", text: "Practise 7 days in a row." },
];

function defaults() {
  return {
    xp: 0,
    streak: 0,
    lastPlayedDay: null,
    dailyDay: null,
    dailySeconds: 0,
    songsFinished: 0,
    best: {}, // `${songId}|${mode}|${difficulty}` -> { score, stars, accuracy }
    achievements: [],
  };
}

export function levelFor(xp) {
  // Level n needs 150 * n XP to clear: 150, 300, 450, ...
  let level = 1;
  let remaining = xp;
  while (remaining >= 150 * level) {
    remaining -= 150 * level;
    level += 1;
  }
  return { level, into: remaining, needed: 150 * level };
}

export function createProfile() {
  let data = { ...defaults(), ...storage.get(PROFILE_KEY, {}) };

  function save() {
    storage.set(PROFILE_KEY, data);
  }

  function rollDaily() {
    const today = todayKey();
    if (data.dailyDay !== today) {
      data.dailyDay = today;
      data.dailySeconds = 0;
    }
  }

  function currentStreak() {
    if (!data.lastPlayedDay) return 0;
    const yesterday = todayKey(new Date(Date.now() - 86400000));
    return data.lastPlayedDay === todayKey() || data.lastPlayedDay === yesterday ? data.streak : 0;
  }

  function touchStreak() {
    const today = todayKey();
    if (data.lastPlayedDay === today) return;
    const yesterday = todayKey(new Date(Date.now() - 86400000));
    data.streak = data.lastPlayedDay === yesterday ? data.streak + 1 : 1;
    data.lastPlayedDay = today;
  }

  function unlock(id, unlocked) {
    if (!data.achievements.includes(id)) {
      data.achievements.push(id);
      unlocked.push(ACHIEVEMENTS.find((a) => a.id === id));
    }
  }

  function bestKey(songId, mode, difficulty) {
    return `${songId}|${mode}|${difficulty}`;
  }

  // Records a finished run. Returns what changed so the results screen can celebrate it.
  function recordRun({ songId, mode, difficulty, results }) {
    rollDaily();
    const levelBefore = levelFor(data.xp).level;
    const unlocked = [];

    data.dailySeconds += results.playedSeconds;
    touchStreak();

    const accuracyBonus = Math.round(results.accuracy * 40);
    const modeFactor = mode === "perform" ? 1.5 : 1;
    const xpGained = mode === "watch" ? 5 : Math.round((10 + results.stars * 15 + accuracyBonus) * modeFactor);
    data.xp += xpGained;

    let isNewBest = false;
    if (mode !== "watch") {
      data.songsFinished += 1;
      const key = bestKey(songId, mode, difficulty);
      const previous = data.best[key];
      if (!previous || results.score > previous.score) {
        isNewBest = Boolean(previous);
        data.best[key] = { score: results.score, stars: Math.max(results.stars, previous?.stars ?? 0), accuracy: results.accuracy };
      } else if (results.stars > previous.stars) {
        previous.stars = results.stars;
      }

      unlock("first-song", unlocked);
      if (results.stars >= 3) unlock("three-stars", unlocked);
      if (results.maxCombo >= 25) unlock("combo-25", unlocked);
      if (results.maxCombo >= 100) unlock("combo-100", unlocked);
      if (results.holdsCompleted >= 10) unlock("hold-master", unlocked);
      if (mode === "perform") unlock("performer", unlocked);
      if (difficulty === "hard") unlock("full-piano", unlocked);
    }
    if (data.streak >= 3) unlock("streak-3", unlocked);
    if (data.streak >= 7) unlock("streak-7", unlocked);

    save();
    const levelAfter = levelFor(data.xp).level;
    return { xpGained, isNewBest, leveledUp: levelAfter > levelBefore, level: levelAfter, unlocked };
  }

  function addPracticeSeconds(seconds) {
    rollDaily();
    data.dailySeconds += seconds;
    save();
  }

  function recordConversion() {
    const unlocked = [];
    unlock("converter", unlocked);
    save();
    return unlocked;
  }

  function bestFor(songId) {
    // Best stars across every mode and difficulty, for the song card.
    let stars = 0;
    let score = 0;
    for (const [key, value] of Object.entries(data.best)) {
      if (key.startsWith(`${songId}|`)) {
        stars = Math.max(stars, value.stars);
        score = Math.max(score, value.score);
      }
    }
    return { stars, score };
  }

  function summary() {
    rollDaily();
    return {
      ...levelFor(data.xp),
      xp: data.xp,
      streak: currentStreak(),
      dailyProgress: Math.min(1, data.dailySeconds / (GAME.dailyGoalMinutes * 60)),
      dailyMinutes: Math.floor(data.dailySeconds / 60),
      achievements: data.achievements,
      totalStars: Object.values(data.best).reduce((sum, b) => sum + b.stars, 0),
    };
  }

  return { recordRun, recordConversion, addPracticeSeconds, bestFor, summary };
}
