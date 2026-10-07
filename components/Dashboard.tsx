import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AppContexts';
import { fetchWeeklyTestResults } from '../services/apiClient';
import { preloadPracticeTopic, preloadVoiceTopic, triggerServerWarmup } from '../services/geminiService';
import { TestResult } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { BrainCircuitIcon } from './Icons';
import DatabaseSetupInstructions from './DatabaseSetupInstructions';

interface WeeklyProgress {
  name: string;
  score: number;
}

const Dashboard: React.FC = () => {
  const { profile, user } = useAuth();
  const [weeklyData, setWeeklyData] = useState<WeeklyProgress[]>([]);
  const [suggestedTopic, setSuggestedTopic] = useState<{ name: string; key: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      if (!user) return;

      setLoading(true);
      setFetchError(null);

      try {
        const { results } = await fetchWeeklyTestResults();
        processWeeklyData(results);
        processSuggestions(results);
      } catch (error: any) {
        console.error('Error fetching weekly data:', error.message);
        setFetchError(error.message);
      } finally {
        setLoading(false);
      }
    };

    const processWeeklyData = (results: TestResult[]) => {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dailyScores: { [key: string]: number } = {};

      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dailyScores[days[d.getDay()]] = 0;
      }

      results.forEach((result) => {
        const dayName = days[new Date(result.created_at).getDay()];
        if (dailyScores[dayName] !== undefined) {
          dailyScores[dayName] += result.score * 100; // 100 XP per correct answer
        }
      });

      const chartData = Object.keys(dailyScores)
        .map((day) => ({
          name: day,
          score: dailyScores[day],
        }))
        .reverse();

      const todayIndex = new Date().getDay();
      const orderedDays = [...days.slice(todayIndex + 1), ...days.slice(0, todayIndex + 1)];
      chartData.sort((a, b) => orderedDays.indexOf(a.name) - orderedDays.indexOf(b.name));

      setWeeklyData(chartData);
    };

    const processSuggestions = (results: TestResult[]) => {
      if (results.length === 0) {
        setSuggestedTopic({ name: "Let's get started!", key: '' });
        return;
      }

      const topicPerformance: { [key: string]: { correct: number; total: number } } = {};
      results.forEach((r) => {
        if (!topicPerformance[r.topic]) {
          topicPerformance[r.topic] = { correct: 0, total: 0 };
        }
        topicPerformance[r.topic].correct += r.score;
        topicPerformance[r.topic].total += r.total_questions;
      });

      let worstTopic: string | null = null;
      let lowestAccuracy = 101;

      for (const topic in topicPerformance) {
        const accuracy =
          (topicPerformance[topic].correct / topicPerformance[topic].total) * 100;
        if (accuracy < lowestAccuracy) {
          lowestAccuracy = accuracy;
          worstTopic = topic;
        }
      }

      if (worstTopic) {
        setSuggestedTopic({
          name: worstTopic,
          key: worstTopic.toLowerCase().replace(/\s+/g, '-'),
        });
      }
    };

    fetchData();
    triggerServerWarmup(undefined, 'Medium', 'both');
    preloadPracticeTopic('Quantitative Aptitude', 5);
    preloadVoiceTopic('Quantitative Aptitude', 'Medium', 5);
  }, [user]);

  const renderSuggestion = () => {
    if (loading) {
      return <p className="mt-2 opacity-90">Analyzing your performance...</p>;
    }
    if (!suggestedTopic) {
      return <p className="mt-2 opacity-90">Complete some tests to get personalized suggestions!</p>;
    }
    if (suggestedTopic.key === '') {
      return (
        <>
          <p className="mt-2 opacity-90">
            Ready to test your skills? Pick a topic and begin your journey.
          </p>
          <p className="text-2xl font-bold mt-4">{suggestedTopic.name}</p>
        </>
      );
    }
    return (
      <>
        <p className="mt-2 opacity-90">
          Based on your recent performance, we recommend focusing on:
        </p>
        <p className="text-2xl font-bold mt-4">{suggestedTopic.name}</p>
      </>
    );
  };

  return (
    <div className="animate-fade-in space-y-6">
      <h1 className="text-3xl font-bold text-gray-800 dark:text-white">
        Welcome back, {profile?.username || 'AptiPro User'}!
      </h1>
      <p className="text-gray-600 dark:text-gray-400">
        Let&apos;s sharpen your skills today. Your next big opportunity is just a test away.
      </p>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Weekly Progress */}
        <div className="lg:col-span-2 p-6 bg-white rounded-2xl shadow-lg dark:bg-gray-800">
          <h2 className="text-xl font-bold mb-4">Weekly Progress (XP)</h2>
          <div style={{ width: '100%', height: 300 }}>
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <p>Loading progress...</p>
              </div>
            ) : fetchError ? (
              <DatabaseSetupInstructions feature="weekly_progress" error={fetchError} />
            ) : weeklyData.reduce((acc, day) => acc + day.score, 0) === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <BrainCircuitIcon size={48} className="text-gray-400 mb-4" />
                <h3 className="font-semibold">No activity this week</h3>
                <p className="text-sm text-gray-500">
                  Complete practice tests to see your progress here.
                </p>
              </div>
            ) : (
              <ResponsiveContainer>
                <BarChart data={weeklyData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="rgba(128, 128,128, 0.2)"
                  />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} />
                  <YAxis axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: 'rgba(249, 115, 22, 0.1)' }}
                    contentStyle={{
                      backgroundColor: 'rgba(31, 41, 55, 0.8)',
                      border: 'none',
                      borderRadius: '0.5rem',
                      color: '#fff',
                    }}
                  />
                  <Bar dataKey="score" radius={[4, 4, 0, 0]}>
                    {weeklyData.map((entry, index) => {
                      const todayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
                        new Date().getDay()
                      ];
                      return (
                        <Cell
                          key={`cell-${index}`}
                          fill={entry.name === todayName ? '#f97316' : '#fca5a5'}
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* AI Suggestion */}
        <div className="p-6 bg-gradient-to-br from-fire-orange-start to-fire-red-end rounded-2xl shadow-lg text-white flex flex-col justify-between">
          <div>
            <h2 className="text-xl font-bold">Personalized Suggestion</h2>
            {renderSuggestion()}
          </div>
          <Link
            to={`/practice/${suggestedTopic?.key || ''}`}
            className="mt-6 w-full text-center px-4 py-2 font-semibold bg-white text-fire-orange-start rounded-lg hover:bg-orange-50 transition"
          >
            {suggestedTopic?.key === '' ? 'Choose a Topic' : 'Start Practicing'}
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
