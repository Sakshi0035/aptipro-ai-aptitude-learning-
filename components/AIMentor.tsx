import React, { useState, useRef, useEffect } from 'react';
import { getAIMentorResponse } from '../services/geminiService';
import { SendIcon } from './Icons';
import { useAuth } from '../contexts/AppContexts';
import Avatar from './Avatar';

interface Message {
    role: 'user' | 'model';
    parts: { text: string }[];
}

const AIMentor: React.FC = () => {
    const { user, profile } = useAuth();
    const [messages, setMessages] = useState<Message[]>([
        { role: 'model', parts: [{ text: "Hello! I'm your AI Mentor. How can I help you with your aptitude preparation today?" }] }
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [performanceData, setPerformanceData] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(scrollToBottom, [messages]);
    
    useEffect(() => {
        try {
            const data = JSON.parse(localStorage.getItem('aptiProPerformance') || '{}');
            if (Object.keys(data).length > 0) {
                let summary = "User Performance Summary:\n";
                for (const topic in data) {
                    const accuracy = data[topic].total > 0 ? (data[topic].correct / data[topic].total) * 100 : 0;
                    summary += `- ${topic}: ${accuracy.toFixed(0)}% accuracy (${data[topic].correct}/${data[topic].total} correct).\n`;
                }
                setPerformanceData(summary);
            }
        } catch (e) {
            console.error("Failed to load performance data", e);
        }
    }, []);

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        const userMessage: Message = { role: 'user', parts: [{ text: input }] };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        const history = messages.slice(1); // Exclude the initial greeting
        const responseText = await getAIMentorResponse(input, history, performanceData);
        
        const modelMessage: Message = { role: 'model', parts: [{ text: responseText }] };
        setMessages(prev => [...prev, modelMessage]);
        setIsLoading(false);
    };

    return (
        <div className="flex flex-col h-full max-w-3xl mx-auto bg-white dark:bg-gray-800 rounded-2xl shadow-lg animate-fade-in">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
                <h1 className="text-xl font-bold text-center">AI Mentor</h1>
            </div>
            <div className="flex-1 p-4 overflow-y-auto">
                <div className="space-y-4">
                    {messages.map((msg, index) => (
                        <div key={index} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            {msg.role === 'model' && <Avatar name="AI" size={32} />}
                            <div className={`max-w-sm md:max-w-md p-3 rounded-2xl ${msg.role === 'user' ? 'bg-gradient-to-r from-fire-orange-start to-fire-red-end text-white rounded-br-none' : 'bg-gray-200 dark:bg-gray-700 rounded-bl-none'}`}>
                                <p style={{ whiteSpace: 'pre-wrap' }}>{msg.parts[0].text}</p>
                            </div>
                            {msg.role === 'user' && <Avatar avatarUrl={profile?.avatar_url} name={profile?.username || user?.email} size={32} />}
                        </div>
                    ))}
                    {isLoading && (
                        <div className="flex justify-start gap-2">
                             <Avatar name="AI" size={32} />
                            <div className="p-3 rounded-2xl bg-gray-200 dark:bg-gray-700 rounded-bl-none">
                                <div className="flex items-center space-x-1">
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"></div>
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div>
                                </div>
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>
            </div>
            <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center space-x-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                        placeholder="Ask me anything about aptitude..."
                        className="flex-1 w-full px-4 py-2 bg-gray-100 dark:bg-gray-700 border-transparent rounded-full focus:outline-none focus:ring-2 focus:ring-fire-orange-start"
                        disabled={isLoading}
                    />
                    <button onClick={handleSend} disabled={isLoading || !input.trim()} className="p-3 bg-gradient-to-r from-fire-orange-start to-fire-red-end text-white rounded-full hover:opacity-90 transition-opacity disabled:opacity-50">
                        <SendIcon />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AIMentor;