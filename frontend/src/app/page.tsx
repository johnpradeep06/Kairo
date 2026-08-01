"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ChatInterface from "../components/ChatInterface";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function Home() {
    const router = useRouter();
    const [role, setRole] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('token');
        const storedRole = localStorage.getItem('role');

        if (!token) {
            router.push('/login');
        } else {
            // eslint-disabl-next-line react-hooks/set-state-in-effect
            setRole(storedRole);
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setLoading(false);
        }
    }, [router]);

    const handleLogout = async () => {
        try {
            const token = localStorage.getItem('token');
            if (token) {
                await fetch(`${API_BASE_URL}/logout`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            }
        } catch (e) {
            console.error("Logout failed", e);
        }
        localStorage.removeItem('token');
        localStorage.removeItem('role');
        router.push('/login');
    };

    if (loading) return <div className="h-[100dvh] bg-bg-primary text-text-primary flex items-center justify-center font-sans">Loading...</div>;

    return (
        <main className="h-[100dvh] w-full bg-bg-primary flex flex-col relative overflow-hidden">
            <div className="flex-1 w-full h-full">
                <ChatInterface role={role} handleLogout={handleLogout} />
            </div>
        </main>
    );
}
