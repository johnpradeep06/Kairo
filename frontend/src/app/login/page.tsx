'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Loader2, ArrowRight } from 'lucide-react';
import { apiUrl } from '../../lib/api';

export default function LoginPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        const formData = new FormData();
        formData.append('username', username);
        formData.append('password', password);

        try {
            const res = await fetch(apiUrl('/token'), {
                method: 'POST',
                body: formData,
            });

            if (!res.ok) {
                throw new Error('Login failed. Check credentials.');
            }

            const data = await res.json();
            localStorage.setItem('token', data.access_token);
            localStorage.setItem('username', username);

            // Fetch user role
            const userRes = await fetch(apiUrl('/users/me'), {
                headers: {
                    'Authorization': `Bearer ${data.access_token}`
                }
            });
            const userData = await userRes.json();
            localStorage.setItem('role', userData.role);

            router.push('/');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-bg-primary relative overflow-hidden font-sans text-text-primary">
            {/* Top Right FAQ Link */}
            <div className="absolute top-6 right-6 z-20">
                <a
                    href="/faq"
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-card-background border border-border-default rounded-xl text-sm font-semibold text-text-secondary hover:text-text-primary hover:border-text-primary transition-all outline-none"
                >
                    FAQ
                </a>
            </div>

            {/* Background Accents */}
            <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-accent/20 blur-[120px] rounded-full pointer-events-none"></div>
            <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-600/20 blur-[120px] rounded-full pointer-events-none"></div>

            <div className="w-full max-w-md p-8 md:p-10 z-10">
                <div className="flex flex-col items-center mb-10">
                    <div className="w-16 h-16 bg-card-background border border-border-default rounded-full flex items-center justify-center mb-6 shadow-xl transition-transform hover:scale-105 duration-300">
                        <Bot size={32} className="text-text-primary" />
                    </div>
                    <h2 className="text-3xl font-bold text-text-primary tracking-tight">Welcome back</h2>
                    <p className="text-text-secondary mt-2 text-sm font-medium">Sign in to Kairo to continue</p>
                </div>

                <form onSubmit={handleLogin} className="space-y-6">
                    {error && (
                        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-center animate-in fade-in zoom-in-95 duration-200">
                            <p className="text-red-400 text-sm font-medium">{error}</p>
                        </div>
                    )}

                    <div className="space-y-4 font-sans">
                        <div>
                            <label className="block text-sm font-medium text-text-secondary mb-2 ml-1">Username</label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="w-full p-4 bg-input-background border border-border-default rounded-xl text-text-primary placeholder-text-secondary/60 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-all shadow-inner text-[15px] font-sans outline-none font-medium"
                                placeholder="Enter your username"
                                required
                            />
                        </div>
                        <div>
                            <div className="flex justify-between items-center mb-2 ml-1 mr-1">
                                <label className="block text-sm font-medium text-text-secondary font-sans">Password</label>
                                <a href="#" className="text-xs text-text-secondary opacity-70 hover:text-text-primary transition-colors font-sans focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none rounded px-0.5 outline-none">Forgot password?</a>
                            </div>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full p-4 bg-input-background border border-border-default rounded-xl text-text-primary placeholder-text-secondary/60 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-all shadow-inner text-[15px] tracking-wide font-sans outline-none font-medium"
                                placeholder="••••••••"
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
                                    Login
                                    <ArrowRight size={18} />
                                </>
                            )}
                        </button>
                    </div>
                </form>

                <div className="flex flex-col items-center gap-4 mt-10">
                    <a
                        href="/register?role=manager"
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-accent/10 border border-accent/20 rounded-full text-xs font-semibold text-accent hover:bg-accent/20 hover:scale-105 active:scale-95 transition-all outline-none"
                    >
                        Set Up Manager Credentials
                    </a>
                    
                    <p className="text-sm text-text-secondary">
                        Don&apos;t have an account?{' '}
                        <a href="/register" className="text-text-primary hover:text-text-secondary underline underline-offset-4 decoration-border-default font-semibold transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none rounded px-0.5 outline-none">
                            Sign up
                        </a>
                    </p>
                </div>

            </div>
        </div>
    );
}
