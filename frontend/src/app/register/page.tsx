'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Loader2, UserPlus } from 'lucide-react';
import { apiUrl } from '../../lib/api';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function RegisterPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            const res = await fetch(apiUrl('/register'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password, role: 'manager' }),
            });

            if (!res.ok) {
                let detail = 'Registration failed';
                try {
                    const data = await res.json();
                    detail = data.detail || detail;
                } catch {
                    detail = `Server error (${res.status}). Please check backend connection.`;
                }
                throw new Error(detail);
            }

            router.push('/login');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-bg-primary relative overflow-hidden font-sans py-12 text-text-primary">
            {/* Background Accents */}
            <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-600/20 blur-[120px] rounded-full pointer-events-none"></div>
            <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-accent/20 blur-[120px] rounded-full pointer-events-none"></div>

            <div className="w-full max-w-md p-8 md:p-10 z-10">
                <div className="flex flex-col items-center mb-10">
                    <div className="w-16 h-16 bg-card-background border border-border-default rounded-full flex items-center justify-center mb-6 shadow-md transition-transform hover:scale-105 duration-300">
                        <Bot size={32} className="text-text-primary" />
                    </div>
                    <h2 className="text-3xl font-bold text-text-primary tracking-tight">Create an account</h2>
                    <p className="text-text-secondary mt-2 text-sm font-medium">Join Kairo — Compliance Knowledge Graph</p>
                </div>

                <form onSubmit={handleRegister} className="space-y-6">
                    {error && (
                        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-center animate-in fade-in zoom-in-95 duration-200">
                            <p className="text-red-400 text-sm font-medium">{error}</p>
                        </div>
                    )}

                    <div className="space-y-5">
                        <div>
                            <label className="block text-sm font-medium text-text-secondary mb-2 ml-1">Username</label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="w-full p-4 bg-input-background border border-border-default rounded-xl text-text-primary placeholder-text-secondary/60 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-all shadow-inner text-[15px] font-sans outline-none font-medium"
                                placeholder="Choose a username"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-text-secondary mb-2 ml-1">Password</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full p-4 bg-input-background border border-border-default rounded-xl text-text-primary placeholder-text-secondary/60 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-all shadow-inner text-[15px] tracking-wide font-sans outline-none font-medium"
                                placeholder="Create a password"
                                required
                            />
                        </div>

                    </div>

                    <div className="pt-2">
                        <button
                            type="submit"
                            disabled={isLoading || !username || !password}
                            className="w-full py-4 px-4 bg-text-primary text-bg-primary font-semibold rounded-xl hover:opacity-90 transition-all flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 shadow-sm hover:shadow-md font-sans focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                        >
                            {isLoading ? <Loader2 size={18} className="animate-spin" /> : (
                                <>
                                    Sign Up
                                    <UserPlus size={18} />
                                </>
                            )}
                        </button>
                    </div>
                </form>

                <div className="text-center mt-10">
                    <p className="text-sm text-text-secondary">
                        Already have an account?{' '}
                        <a href="/login" className="text-text-primary hover:text-text-secondary underline underline-offset-4 decoration-border-default font-semibold transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none rounded px-0.5 outline-none">
                            Log in
                        </a>
                    </p>
                </div>
            </div>
        </div>
    );
}
