const DAY_MS = 24 * 60 * 60 * 1000;

export function intervalDaysByStreak(streak) {
  if (streak <= 1) return 1;
  if (streak === 2) return 3;
  if (streak === 3) return 7;
  if (streak === 4) return 14;
  return 30;
}

export function addDaysIso(now, days) {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

export function nextIsoForX(now, policy) {
  return policy === "tomorrow" ? addDaysIso(now, 1) : now.toISOString();
}

export function applyMeaningGrade(progress, grade, now, settings) {
  const p = { ...progress };
  p.meaningLastAt = now.toISOString();
  if (grade === "o") {
    p.meaningStreak = (p.meaningStreak || 0) + 1;
    p.meaningCorrect = (p.meaningCorrect || 0) + 1;
    p.meaningNextReviewAt = addDaysIso(now, intervalDaysByStreak(p.meaningStreak));
  } else if (grade === "triangle") {
    p.meaningStreak = 0;
    p.meaningPartial = (p.meaningPartial || 0) + 1;
    p.meaningNextReviewAt = addDaysIso(now, 1);
  } else {
    p.meaningStreak = 0;
    p.meaningWrong = (p.meaningWrong || 0) + 1;
    p.meaningNextReviewAt = nextIsoForX(now, settings.meaningXNext || "today");
  }
  return p;
}

export function applySpellingGrade(progress, grade, now, settings) {
  const p = { ...progress };
  p.spellingLastAt = now.toISOString();
  if (grade === "o") {
    p.spellingStreak = (p.spellingStreak || 0) + 1;
    p.spellingCorrect = (p.spellingCorrect || 0) + 1;
    p.spellingNextReviewAt = addDaysIso(now, intervalDaysByStreak(p.spellingStreak));
  } else {
    p.spellingStreak = 0;
    p.spellingWrong = (p.spellingWrong || 0) + 1;
    p.spellingNextReviewAt = nextIsoForX(now, settings.spellingXNext || "today");
  }
  return p;
}

export function scoreMeaning(p) {
  const wrong = p?.meaningWrong || 0;
  const partial = p?.meaningPartial || 0;
  const correct = p?.meaningCorrect || 0;
  return wrong * 3 + partial * 2 - correct;
}

export function scoreSpelling(p) {
  const wrong = p?.spellingWrong || 0;
  const correct = p?.spellingCorrect || 0;
  return wrong * 3 - correct;
}


