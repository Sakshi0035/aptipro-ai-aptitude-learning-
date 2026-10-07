import { Question, VoiceQuestion } from '../types';
import { apiFetch } from './apiClient';

const PRACTICE_CACHE_STORAGE_KEY = 'aptipro_practice_pool_v1';
const VOICE_CACHE_STORAGE_KEY = 'aptipro_voice_pool_v1';

const clientPracticePool = new Map<string, Question[]>();
const clientVoicePool = new Map<string, VoiceQuestion[]>();
const seenQuestionTexts = new Set<string>();
const inFlightPrefetches = new Map<string, Promise<any>>();

// Hydrate client-side pools from sessionStorage on startup
try {
  if (typeof window !== 'undefined') {
    const savedPractice = sessionStorage.getItem(PRACTICE_CACHE_STORAGE_KEY);
    if (savedPractice) {
      const parsed = JSON.parse(savedPractice) as Record<string, Question[]>;
      Object.entries(parsed).forEach(([k, v]) => {
        if (Array.isArray(v)) clientPracticePool.set(k, v);
      });
    }
    const savedVoice = sessionStorage.getItem(VOICE_CACHE_STORAGE_KEY);
    if (savedVoice) {
      const parsed = JSON.parse(savedVoice) as Record<string, VoiceQuestion[]>;
      Object.entries(parsed).forEach(([k, v]) => {
        if (Array.isArray(v)) clientVoicePool.set(k, v);
      });
    }
  }
} catch {
  // Ignore storage parse errors
}

function saveClientPoolsToStorage() {
  try {
    if (typeof window !== 'undefined') {
      const practiceObj: Record<string, Question[]> = {};
      clientPracticePool.forEach((v, k) => {
        practiceObj[k] = v.slice(0, 20);
      });
      sessionStorage.setItem(PRACTICE_CACHE_STORAGE_KEY, JSON.stringify(practiceObj));

      const voiceObj: Record<string, VoiceQuestion[]> = {};
      clientVoicePool.forEach((v, k) => {
        voiceObj[k] = v.slice(0, 25);
      });
      sessionStorage.setItem(VOICE_CACHE_STORAGE_KEY, JSON.stringify(voiceObj));
    }
  } catch {
    // Ignore storage quota errors
  }
}

function getVoiceKey(topic: string, difficulty: string): string {
  return `${topic.trim()}::${difficulty.trim()}`;
}

export function triggerServerWarmup(
  topic?: string,
  difficulty = 'Medium',
  kind: 'practice' | 'voice' | 'both' = 'both'
): void {
  apiFetch('/gemini/warmup', {
    method: 'POST',
    body: JSON.stringify({ topic, difficulty, kind }),
  }).catch(() => {});
}

export function preloadPracticeTopic(topic: string, count = 5): Promise<Question[]> {
  const key = topic.trim();
  const existing = clientPracticePool.get(key) || [];
  if (existing.length >= count) {
    return Promise.resolve(existing);
  }

  const inflightKey = `practice::${key}`;
  const inflight = inFlightPrefetches.get(inflightKey);
  if (inflight) return inflight;

  const p = apiFetch<{ questions: Question[] }>('/gemini/questions', {
    method: 'POST',
    body: JSON.stringify({
      topic: key,
      count,
      excludeQuestions: [
        ...Array.from(seenQuestionTexts),
        ...existing.map((q) => q.question),
      ],
    }),
  })
    .then((data) => {
      const fetched = data.questions || [];
      if (fetched.length > 0) {
        const current = clientPracticePool.get(key) || [];
        const currentSet = new Set(current.map((q) => q.question.trim().toLowerCase()));
        const merged = [...current];
        for (const item of fetched) {
          const norm = item.question.trim().toLowerCase();
          if (!currentSet.has(norm)) {
            currentSet.add(norm);
            merged.push(item);
          }
        }
        clientPracticePool.set(key, merged);
        saveClientPoolsToStorage();
        return merged;
      }
      return existing;
    })
    .catch((err) => {
      console.warn('Preload practice topic failed:', err);
      return existing;
    })
    .finally(() => {
      inFlightPrefetches.delete(inflightKey);
    });

  inFlightPrefetches.set(inflightKey, p);
  return p;
}

export function preloadVoiceTopic(
  topic: string,
  difficulty: string,
  count = 6
): Promise<VoiceQuestion[]> {
  const vKey = getVoiceKey(topic, difficulty);
  const existing = clientVoicePool.get(vKey) || [];
  if (existing.length >= count) {
    return Promise.resolve(existing);
  }

  const inflightKey = `voice::${vKey}`;
  const inflight = inFlightPrefetches.get(inflightKey);
  if (inflight) return inflight;

  const p = apiFetch<{ questions: VoiceQuestion[] }>('/gemini/voice-questions', {
    method: 'POST',
    body: JSON.stringify({
      topic: topic.trim(),
      difficulty: difficulty.trim(),
      count,
      excludeQuestions: [
        ...Array.from(seenQuestionTexts),
        ...existing.map((q) => q.question),
      ],
    }),
  })
    .then((data) => {
      const fetched = data.questions || [];
      if (fetched.length > 0) {
        const current = clientVoicePool.get(vKey) || [];
        const currentSet = new Set(current.map((q) => q.question.trim().toLowerCase()));
        const merged = [...current];
        for (const item of fetched) {
          const norm = item.question.trim().toLowerCase();
          if (!currentSet.has(norm)) {
            currentSet.add(norm);
            merged.push(item);
          }
        }
        clientVoicePool.set(vKey, merged);
        saveClientPoolsToStorage();
        return merged;
      }
      return existing;
    })
    .catch((err) => {
      console.warn('Preload voice topic failed:', err);
      return existing;
    })
    .finally(() => {
      inFlightPrefetches.delete(inflightKey);
    });

  inFlightPrefetches.set(inflightKey, p);
  return p;
}

export const generateAptitudeQuestions = async (
  topic: string,
  count: number
): Promise<Question[]> => {
  const key = topic.trim();
  const cached = clientPracticePool.get(key) || [];

  if (cached.length >= count) {
    const selected = cached.slice(0, count);
    const remaining = cached.slice(count);
    clientPracticePool.set(key, remaining);
    selected.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));
    saveClientPoolsToStorage();

    // Replenish client pool in background for next test
    setTimeout(() => {
      preloadPracticeTopic(key, count);
    }, 50);

    return selected;
  }

  try {
    const needed = count - cached.length;
    const data = await apiFetch<{ questions: Question[] }>('/gemini/questions', {
      method: 'POST',
      body: JSON.stringify({
        topic: key,
        count: Math.max(needed, count),
        excludeQuestions: [
          ...Array.from(seenQuestionTexts),
          ...cached.map((q) => q.question),
        ],
      }),
    });

    const fetched = data.questions || [];
    const combined = [...cached, ...fetched];
    const selected = combined.slice(0, count);
    const leftover = combined.slice(count);

    clientPracticePool.set(key, leftover);
    selected.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));
    saveClientPoolsToStorage();

    // Preload next set in background
    setTimeout(() => {
      preloadPracticeTopic(key, count);
    }, 100);

    return selected;
  } catch (error) {
    console.error('Error generating questions:', error);
    return cached;
  }
};

export const generateVoiceTestQuestions = async (
  topic: string,
  difficulty: string,
  count: number
): Promise<VoiceQuestion[]> => {
  const vKey = getVoiceKey(topic, difficulty);
  const cached = clientVoicePool.get(vKey) || [];

  if (cached.length >= count) {
    const selected = cached.slice(0, count);
    const remaining = cached.slice(count);
    clientVoicePool.set(vKey, remaining);
    selected.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));
    saveClientPoolsToStorage();

    setTimeout(() => {
      preloadVoiceTopic(topic, difficulty, Math.max(count, 5));
    }, 50);

    return selected;
  }

  try {
    const data = await apiFetch<{ questions: VoiceQuestion[] }>('/gemini/voice-questions', {
      method: 'POST',
      body: JSON.stringify({
        topic: topic.trim(),
        difficulty: difficulty.trim(),
        count,
        excludeQuestions: [
          ...Array.from(seenQuestionTexts),
          ...cached.map((q) => q.question),
        ],
      }),
    });
    const fetched = data.questions || [];
    const combined = [...cached, ...fetched];
    const selected = combined.slice(0, count);
    const leftover = combined.slice(count);

    clientVoicePool.set(vKey, leftover);
    selected.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));
    saveClientPoolsToStorage();

    setTimeout(() => {
      preloadVoiceTopic(topic, difficulty, Math.max(count, 5));
    }, 100);

    return selected;
  } catch (error) {
    console.error('Error generating voice test questions:', error);
    return cached;
  }
};

/**
 * Progressive Voice Test loader:
 * Returns available/initial questions immediately so the Voice Test starts right away,
 * and preloads any remaining questions in the background while the user answers Question 1.
 */
export const startProgressiveVoiceTest = async (
  topic: string,
  difficulty: string,
  totalCount: number,
  onMoreQuestionsLoaded: (additionalQuestions: VoiceQuestion[]) => void
): Promise<VoiceQuestion[]> => {
  const vKey = getVoiceKey(topic, difficulty);
  const cached = clientVoicePool.get(vKey) || [];

  if (cached.length >= totalCount) {
    const selected = cached.slice(0, totalCount);
    clientVoicePool.set(vKey, cached.slice(totalCount));
    selected.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));
    saveClientPoolsToStorage();

    setTimeout(() => {
      preloadVoiceTopic(topic, difficulty, Math.max(totalCount, 6));
    }, 50);

    return selected;
  }

  if (cached.length > 0) {
    const initial = [...cached];
    clientVoicePool.set(vKey, []);
    initial.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));
    saveClientPoolsToStorage();

    const remainingNeeded = totalCount - initial.length;
    if (remainingNeeded > 0) {
      apiFetch<{ questions: VoiceQuestion[] }>('/gemini/voice-questions', {
        method: 'POST',
        body: JSON.stringify({
          topic: topic.trim(),
          difficulty: difficulty.trim(),
          count: remainingNeeded,
          excludeQuestions: Array.from(seenQuestionTexts),
        }),
      })
        .then((data) => {
          const more = (data.questions || []).slice(0, remainingNeeded);
          more.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));
          if (more.length > 0) {
            onMoreQuestionsLoaded(more);
          }
          preloadVoiceTopic(topic, difficulty, 5);
        })
        .catch((err) => console.error('Background voice question fetch error:', err));
    }

    return initial;
  }

  // Cold start: request initial batch with allowPartial=true so server returns immediately if Neon pool has items
  const initialRequestCount = Math.min(totalCount, 3);
  const data = await apiFetch<{ questions: VoiceQuestion[] }>('/gemini/voice-questions', {
    method: 'POST',
    body: JSON.stringify({
      topic: topic.trim(),
      difficulty: difficulty.trim(),
      count: totalCount,
      allowPartial: true,
      excludeQuestions: Array.from(seenQuestionTexts),
    }),
  });

  const initialBatch = (data.questions || []).slice(0, totalCount);
  initialBatch.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));

  const stillNeeded = totalCount - initialBatch.length;
  if (stillNeeded > 0 && initialBatch.length >= 1) {
    apiFetch<{ questions: VoiceQuestion[] }>('/gemini/voice-questions', {
      method: 'POST',
      body: JSON.stringify({
        topic: topic.trim(),
        difficulty: difficulty.trim(),
        count: stillNeeded,
        excludeQuestions: Array.from(seenQuestionTexts),
      }),
    })
      .then((remData) => {
        const more = (remData.questions || []).slice(0, stillNeeded);
        more.forEach((q) => seenQuestionTexts.add(q.question.trim().toLowerCase()));
        if (more.length > 0) {
          onMoreQuestionsLoaded(more);
        }
        preloadVoiceTopic(topic, difficulty, 5);
      })
      .catch((err) => console.error('Background voice remainder error:', err));
  } else {
    setTimeout(() => {
      preloadVoiceTopic(topic, difficulty, Math.max(initialRequestCount, 5));
    }, 100);
  }

  return initialBatch;
};

export const getAIMentorResponse = async (
  prompt: string,
  history: { role: 'user' | 'model'; parts: { text: string }[] }[],
  performanceData?: string
): Promise<string> => {
  try {
    const data = await apiFetch<{ text: string }>('/gemini/mentor', {
      method: 'POST',
      body: JSON.stringify({ prompt, history, performanceData }),
    });
    return data.text || 'Sorry, I encountered an error. Please try again.';
  } catch (error) {
    console.error('Error getting AI mentor response:', error);
    return 'Sorry, I encountered an error. Please try again.';
  }
};

export const evaluateSpokenAnswer = async (
  question: string,
  correctAnswer: string,
  spokenAnswer: string
): Promise<{ isCorrect: boolean; feedback: string }> => {
  try {
    return await apiFetch<{ isCorrect: boolean; feedback: string }>('/gemini/evaluate-spoken', {
      method: 'POST',
      body: JSON.stringify({ question, correctAnswer, spokenAnswer }),
    });
  } catch (error) {
    console.error('Error evaluating answer:', error);
    if (spokenAnswer.toLowerCase().includes(correctAnswer.toLowerCase())) {
      return { isCorrect: true, feedback: 'Correct!' };
    }
    return {
      isCorrect: false,
      feedback: `Sorry, an error occurred during evaluation. The expected answer is similar to "${correctAnswer}".`,
    };
  }
};
