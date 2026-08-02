'use client';

import { useRouter } from 'next/navigation';
import { Bot, ArrowLeft } from 'lucide-react';

export default function FAQPage() {
    const router = useRouter();

    return (
        <div className="flex min-h-screen items-center justify-center bg-bg-primary relative overflow-y-auto font-sans text-text-primary py-16 px-4">
            {/* Top Right Go Back Button */}
            <div className="absolute top-6 right-6 z-20">
                <button
                    onClick={() => router.push('/login')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-card-background border border-border-default rounded-xl text-sm font-semibold text-text-secondary hover:text-text-primary hover:border-text-primary transition-all outline-none cursor-pointer"
                >
                    <ArrowLeft size={16} />
                    Go Back
                </button>
            </div>

            {/* Background Accents */}
            <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-accent/20 blur-[120px] rounded-full pointer-events-none"></div>
            <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-600/20 blur-[120px] rounded-full pointer-events-none"></div>

            <div className="w-full max-w-2xl p-8 md:p-10 z-10 border border-border-default bg-card-background/50 backdrop-blur-xl rounded-3xl shadow-2xl space-y-10 animate-in fade-in duration-300">
                <div className="flex flex-col items-center">
                    <div className="w-16 h-16 bg-card-background border border-border-default rounded-full flex items-center justify-center mb-6 shadow-xl">
                        <Bot size={32} className="text-text-primary" />
                    </div>
                    <h2 className="text-3xl font-bold text-text-primary tracking-tight">Kairo Compliance FAQ</h2>
                    <p className="text-text-secondary mt-2 text-sm font-medium">Frequently Asked Questions & Product Guide</p>
                </div>

                <div className="space-y-8">
                    <div className="space-y-3">
                        <h3 className="text-lg font-semibold text-text-primary">What is Kairo?</h3>
                        <p className="text-sm text-text-secondary leading-relaxed">
                            Kairo is an Enterprise Compliance Copilot that unifies compliance reasoning and security auditing. 
                            By combining a dense Knowledge Graph representation with structured Vector Retrieval, Kairo helps 
                            compliance officers and security engineers inspect complex system dependencies, verify controls, 
                            and track organizational risks dynamically.
                        </p>
                    </div>

                    <div className="space-y-3">
                        <h3 className="text-lg font-semibold text-text-primary">What do users have to do?</h3>
                        <p className="text-sm text-text-secondary leading-relaxed">
                            Users simply upload compliance records, corporate security policies, system manuals, or threat registers. 
                            Kairo automatically parses the documentation, resolves capital acronyms and compliance terms, builds 
                            co-occurrence relationships on the same logical sentences, and indexes the parsed chunks.
                        </p>
                    </div>

                    <div className="space-y-3">
                        <h3 className="text-lg font-semibold text-text-primary">What does Kairo do for them?</h3>
                        <p className="text-sm text-text-secondary leading-relaxed">
                            Kairo acts as a unified reasoning engine. It maps complex compliance queries to structural graph traversals, 
                            resolves relationships between departments, systems, and controls, generates answers using secure single-call 
                            LLM synthesis, attaches direct source citations, and conducts automatic hallucination auditing.
                        </p>
                    </div>
                </div>

                <div className="pt-6 border-t border-border-default text-center">
                    <button
                        onClick={() => router.push('/register')}
                        className="px-6 py-3 bg-text-primary text-bg-primary text-sm font-semibold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer shadow-sm hover:shadow-md"
                    >
                        Register a New Account
                    </button>
                </div>
            </div>
        </div>
    );
}
