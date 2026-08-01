'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Loader2, UserPlus } from 'lucide-react';
import { apiUrl } from '../../../lib/api';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function AdminRegisterPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [setupToken, setSetupToken] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            const res = await fetch(apiUrl('/register_admin'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password, role: 'manager', setup_token: setupToken }),
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

            // Redirect directly to the admin login page upon success
            router.push('/ops_admin/login');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-[#121212] relative overflow-hidden font-sans py-12">
            {/* Background Accents (Red/Orange for distinct Admin feel) */}
            <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-orange-600/10 blur-[120px] rounded-full pointer-events-none"></div>
            <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-red-600/10 blur-[120px] rounded-full pointer-events-none"></div>

            <div className="w-full max-w-md p-8 md:p-10 z-10 border border-white/5 bg-[#1a1a1a]/50 backdrop-blur-xl rounded-3xl shadow-2xl">
                <div className="flex flex-col items-center mb-10">
                    <div className="w-16 h-16 bg-white/10 rounded-full flex items-center justify-center mb-6 border border-white/20 shadow-[0_0_30px_rgba(255,255,255,0.05)] transition-transform hover:scale-105 duration-300">
                        <ShieldCheck size={32} className="text-white" />
                    </div>
                    <h2 className="text-3xl font-bold text-white tracking-tight">Admin Registration</h2>
                    <p className="text-gray-400 mt-2 text-sm font-medium">Create a new privileged account</p>
                </div>

                <form onSubmit={handleRegister} className="space-y-6">
                    {error && (
                        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-center animate-in fade-in zoom-in-95 duration-200">
                            <p className="text-red-400 text-sm font-medium">{error}</p>
                        </div>
                    )}

                    <div className="space-y-5">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2 ml-1">Admin Username</label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="w-full p-4 bg-[#121212] border border-white/10 rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/50 transition-all shadow-inner text-[15px]"
                                placeholder="Choose a username"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2 ml-1">Password</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full p-4 bg-[#121212] border border-white/10 rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/50 transition-all shadow-inner text-[15px] tracking-wide"
                                placeholder="Create a password"
                                required
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2 ml-1">Admin Setup Token</label>
                            <input
                                type="password"
                                value={setupToken}
                                onChange={(e) => setSetupToken(e.target.value)}
                                className="w-full p-4 bg-[#121212] border border-white/10 rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/50 transition-all shadow-inner text-[15px] tracking-wide"
                                placeholder="ADMIN_SETUP_TOKEN from the backend .env"
                                required
                            />
                            <p className="text-xs text-gray-600 mt-2 ml-1 leading-relaxed">
                                This page only works for the very first manager account. Once one exists,
                                further accounts must be created by a signed-in manager.
                            </p>
                        </div>
                    </div>

                    <div className="pt-2">
                        <button
                            type="submit"
                            disabled={isLoading || !username || !password || !setupToken}
                            className="w-full py-4 px-4 bg-white text-black font-semibold rounded-xl hover:bg-gray-200 transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(255,255,255,0.1)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:scale-100 disabled:shadow-none"
                        >
                            {isLoading ? <Loader2 size={18} className="animate-spin" /> : (
                                <>
                                    Create Admin Account
                                    <UserPlus size={18} />
                                </>
                            )}
                        </button>
                    </div>
                </form>

                <div className="text-center mt-10 border-t border-white/5 pt-6">
                    <p className="text-sm text-gray-500">
                        Already have an admin account?{' '}
                        <a href="/ops_admin/login" className="text-gray-400 hover:text-white underline underline-offset-4 decoration-white/20 hover:decoration-white/60 font-medium transition-all">
                            Log in here
                        </a>
                    </p>
                </div>
            </div>
        </div>
    );
}
