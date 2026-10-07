import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  generateAptitudeQuestions,
  preloadPracticeTopic,
  triggerServerWarmup,
} from '../services/geminiService';
import { recordTestResult } from '../services/apiClient';
import { useAuth } from '../contexts/AppContexts';
import { Question } from '../types';
import { ArrowLeftIcon, ClockIcon, LightbulbIcon, XIcon } from './Icons';
import DatabaseSetupInstructions from './DatabaseSetupInstructions';

type TestState = 'not-started' | 'loading' | 'in-progress' | 'completed';
type Topic = { name: string; description: string; key: string };

const topics: Topic[] = [
  {
    name: 'Quantitative Aptitude',
    description: 'Test your numerical and mathematical skills.',
    key: 'quantitative-aptitude',
  },
  {
    name: 'Logical Reasoning',
    description: 'Assess your problem-solving abilities.',
    key: 'logical-reasoning',
  },
  {
    name: 'Verbal Ability',
    description: 'Check your command over the English language.',
    key: 'verbal-ability',
  },
  {
    name: 'General Knowledge',
    description: 'Evaluate your awareness of current affairs.',
    key: 'general-knowledge',
  },
  {
    name: 'Data Interpretation',
    description: 'Analyze data from charts and graphs.',
    key: 'data-interpretation',
  },
];

const Practice: React.FC = () => {
  const { topic: topicKey } = useParams<{ topic: string }>();
  const navigate = useNavigate();
  const { user, setProfile } = useAuth();

  const [testState, setTestState] = useState<TestState>('not-started');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [showExplanation, setShowExplanation] = useState(false);
  const [timeLeft, setTimeLeft] = useState(300); // 5 minutes
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabWarning, setTabWarning] = useState(false);
  const [showConfirmEndModal, setShowConfirmEndModal] = useState(false);

  const selectedTopic = topics.find((t) => t.key === topicKey);

  // Preload topics in background when opening Practice page
  useEffect(() => {
    triggerServerWarmup(undefined, 'Medium', 'practice');
    // Preload the first two most popular topics immediately, then the rest
    preloadPracticeTopic(topics[0].name, 5).then(() => {
      topics.slice(1).forEach((t) => {
        preloadPracticeTopic(t.name, 5);
      });
    });
  }, []);

  useEffect(() => {
    if (topicKey && selectedTopic) {
      startTest(selectedTopic.name);
    } else {
      resetTest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicKey]);

  useEffect(() => {
    if (testState === 'in-progress' && timeLeft > 0) {
      const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
      return () => clearTimeout(timer);
    }
    if (timeLeft === 0 && testState === 'in-progress') {
      handleCompletion();
    }
  }, [timeLeft, testState]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && testState === 'in-progress' && !showConfirmEndModal) {
        setTabWarning(true);
      }
    };

    if (testState === 'in-progress') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [testState, showConfirmEndModal]);

  const handleCompletion = async () => {
    if (testState === 'completed') return;
    setTestState('completed');

    const score = answers.filter(
      (ans, i) => questions[i] && ans === questions[i].correctAnswer
    ).length;
    setSaveError(null);

    if (selectedTopic && user) {
      try {
        try {
          const perf = JSON.parse(localStorage.getItem('aptiProPerformance') || '{}');
          if (!perf[selectedTopic.name]) {
            perf[selectedTopic.name] = { correct: 0, total: 0 };
          }
          perf[selectedTopic.name].correct += score;
          perf[selectedTopic.name].total += questions.length;
          localStorage.setItem('aptiProPerformance', JSON.stringify(perf));
        } catch {
          // Ignore storage quota issues
        }

        const res = await recordTestResult(selectedTopic.name, score, questions.length);
        if (res.profile) {
          setProfile(res.profile);
        }
      } catch (e: any) {
        console.error('Failed to save performance data:', e);
        setSaveError(e.message);
      }
    }
  };

  const startTest = async (topicName: string) => {
    setTestState('loading');
    setSaveError(null);
    setLoadError(null);
    setTabWarning(false);
    const fetchedQuestions = await generateAptitudeQuestions(topicName, 5);
    if (fetchedQuestions.length > 0) {
      setQuestions(fetchedQuestions);
      setAnswers(new Array(fetchedQuestions.length).fill(null));
      setCurrentQuestionIndex(0);
      setShowExplanation(false);
      setTimeLeft(300);
      setTestState('in-progress');
    } else {
      setTestState('not-started');
      setLoadError('Could not load questions right now. Please try again.');
      navigate('/practice');
    }
  };

  const handleAnswer = (option: string) => {
    const newAnswers = [...answers];
    newAnswers[currentQuestionIndex] = option;
    setAnswers(newAnswers);
    setShowExplanation(true);
  };

  const goToNextQuestion = () => {
    setShowExplanation(false);
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      handleCompletion();
    }
  };

  const resetTest = () => {
    setTestState('not-started');
    setQuestions([]);
    setShowConfirmEndModal(false);
    setTabWarning(false);
    navigate('/practice');
  };

  if (!topicKey || !selectedTopic) {
    return <TopicSelection loadError={loadError} />;
  }

  if (testState === 'completed') {
    const score = answers.filter((ans, i) => ans === questions[i].correctAnswer).length;
    return (
      <div className="p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg animate-fade-in text-center">
        <h2 className="text-3xl font-bold text-fire-orange-start mb-4">Test Completed!</h2>
        <p className="text-xl mb-2">You scored:</p>
        <p className="text-5xl font-bold mb-2">
          {score} / {questions.length}
        </p>
        {saveError ? (
          <div className="my-6">
            <DatabaseSetupInstructions feature="weekly_progress" error={saveError} />
          </div>
        ) : (
          <p className="text-lg font-semibold text-green-500 mb-6">+{score * 100} XP Earned</p>
        )}
        <button
          onClick={resetTest}
          className="px-6 py-2 font-semibold text-white bg-gradient-to-r from-fire-orange-start to-fire-red-end rounded-lg hover:opacity-90 transition-opacity"
        >
          Take Another Test
        </button>
      </div>
    );
  }

  const currentQuestion = questions[currentQuestionIndex];

  // Render the Practice Test UI shell immediately, showing a lightweight inline skeleton only while fetching
  return (
    <div className="relative p-4 sm:p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg animate-fade-in">
      <button
        onClick={() => (testState === 'loading' ? resetTest() : setShowConfirmEndModal(true))}
        className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 z-20"
      >
        <XIcon />
      </button>

      {tabWarning && (
        <div className="mb-4 p-3 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 rounded-lg flex justify-between items-center text-sm">
          <span>
            Warning: Switching tabs during a test is not recommended. The timer is still running.
          </span>
          <button onClick={() => setTabWarning(false)} className="ml-2 font-bold">
            Dismiss
          </button>
        </div>
      )}

      {showConfirmEndModal && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-30 rounded-2xl">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl text-center w-11/12 max-w-sm">
            <h3 className="text-lg font-bold mb-2">End Test?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Are you sure? Your progress will not be saved.
            </p>
            <div className="flex justify-center gap-4">
              <button
                onClick={() => setShowConfirmEndModal(false)}
                className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-600 text-sm font-semibold"
              >
                Continue Test
              </button>
              <button
                onClick={resetTest}
                className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-semibold"
              >
                End Test
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center mb-4">
        <button
          onClick={() => (testState === 'loading' ? resetTest() : setShowConfirmEndModal(true))}
          className="flex items-center text-sm text-gray-600 dark:text-gray-400 hover:text-black dark:hover:text-white"
        >
          <ArrowLeftIcon />
          <span className="ml-2">Back to Topics</span>
        </button>
        <div className="flex items-center text-lg font-semibold text-fire-red-end mr-8">
          <ClockIcon />
          <span className="ml-2">
            {Math.floor(timeLeft / 60)}:{('0' + (timeLeft % 60)).slice(-2)}
          </span>
        </div>
      </div>

      {testState === 'loading' || !currentQuestion ? (
        <div className="py-6 space-y-4 animate-pulse">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-fire-orange-start">
              Preparing {selectedTopic.name} questions...
            </span>
          </div>
          <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-3/4"></div>
          <div className="space-y-3 pt-2">
            {[0, 1, 2, 3].map((idx) => (
              <div
                key={idx}
                className="h-14 bg-gray-100 dark:bg-gray-700/60 border-2 border-gray-200 dark:border-gray-700 rounded-lg"
              ></div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Question {currentQuestionIndex + 1} of {questions.length}
            </p>
            <p className="text-xl font-semibold mt-1">{currentQuestion.question}</p>
          </div>

          <div className="space-y-3">
            {currentQuestion.options.map((option, index) => {
              const isSelected = answers[currentQuestionIndex] === option;
              const isCorrect = currentQuestion.correctAnswer === option;
              let buttonClass =
                'border-gray-300 dark:border-gray-600 hover:border-fire-orange-start hover:bg-orange-50 dark:hover:bg-gray-700';
              if (showExplanation) {
                if (isCorrect) {
                  buttonClass =
                    'bg-green-100 border-green-500 text-green-800 dark:bg-green-900 dark:text-green-200 dark:border-green-700';
                } else if (isSelected && !isCorrect) {
                  buttonClass =
                    'bg-red-100 border-red-500 text-red-800 dark:bg-red-900 dark:text-red-200 dark:border-red-700';
                }
              } else if (isSelected) {
                buttonClass =
                  'border-fire-orange-start bg-orange-100 dark:bg-gray-700 dark:border-fire-orange-start';
              }
              return (
                <button
                  key={index}
                  onClick={() => handleAnswer(option)}
                  disabled={showExplanation}
                  className={`w-full text-left p-4 border-2 rounded-lg transition-all ${buttonClass}`}
                >
                  {option}
                </button>
              );
            })}
          </div>

          {showExplanation && (
            <div className="mt-6 p-4 bg-orange-50 dark:bg-gray-700/50 rounded-lg animate-fade-in">
              <div className="flex items-start">
                <LightbulbIcon className="text-yellow-500 mt-1" />
                <div className="ml-3">
                  <h3 className="font-bold">Explanation</h3>
                  <p className="text-sm mt-1">{currentQuestion.explanation}</p>
                </div>
              </div>
              <button
                onClick={goToNextQuestion}
                className="mt-4 w-full px-6 py-2 font-semibold text-white bg-gradient-to-r from-fire-orange-start to-fire-red-end rounded-lg hover:opacity-90 transition-opacity"
              >
                {currentQuestionIndex < questions.length - 1 ? 'Next Question' : 'Finish Test'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const TopicSelection: React.FC<{ loadError?: string | null }> = ({ loadError }) => {
  const navigate = useNavigate();
  return (
    <div className="animate-fade-in">
      <h1 className="text-3xl font-bold mb-6">Choose a Topic to Practice</h1>
      {loadError && (
        <div className="mb-6 p-4 bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200 rounded-xl">
          {loadError}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {topics.map((topic) => (
          <div
            key={topic.key}
            onMouseEnter={() => preloadPracticeTopic(topic.name, 5)}
            onClick={() => navigate(`/practice/${topic.key}`)}
            className="p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg hover:shadow-2xl hover:-translate-y-1 transition-all transform cursor-pointer"
          >
            <h2 className="text-xl font-bold text-fire-orange-start">{topic.name}</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">{topic.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Practice;
