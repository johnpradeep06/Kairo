'use client';

import { useState, useRef, useEffect } from 'react';
import { UploadCloud, FileType, CheckCircle, AlertCircle, Loader2, X, Trash2 } from 'lucide-react';
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { apiJson } from "../lib/api";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface UploadProps {
    onUploadSuccess?: () => void;
}

interface QueueItem {
    id: string;
    file: File;
    status: 'idle' | 'uploading' | 'success' | 'error';
    progress: number;
    error?: string;
}

export default function UploadComponent({ onUploadSuccess }: UploadProps = {}) {
    const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [progressNote, setProgressNote] = useState('');
    const [chunkCount, setChunkCount] = useState<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            addFilesToQueue(Array.from(e.target.files));
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            addFilesToQueue(Array.from(e.dataTransfer.files));
        }
    };

    const addFilesToQueue = (files: File[]) => {
        const newItems: QueueItem[] = files.map(file => ({
            id: `${file.name}-${Date.now()}-${Math.random()}`,
            file,
            status: 'idle',
            progress: 0
        }));
        setUploadQueue(prev => [...prev, ...newItems]);
    };

    const startUpload = (id: string, file: File) => {
        setUploadQueue(prev => prev.map(item => item.id === id ? { ...item, status: 'uploading' } : item));

        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('file', file);

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const progress = Math.round((e.loaded / e.total) * 100);
                setUploadQueue(prev => prev.map(item => item.id === id ? { ...item, progress } : item));
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                setUploadQueue(prev => prev.map(item => item.id === id ? { ...item, status: 'success', progress: 100 } : item));
                if (onUploadSuccess) onUploadSuccess();
            } else {
                let error = 'Upload failed';
                try {
                    const res = JSON.parse(xhr.responseText);
                    error = res.detail || error;
                } catch (e) { }
                setUploadQueue(prev => prev.map(item => item.id === id ? { ...item, status: 'error', error } : item));
            }
        });

        xhr.addEventListener('error', () => {
            setUploadQueue(prev => prev.map(item => item.id === id ? { ...item, status: 'error', error: 'Network error' } : item));
        });

        const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
        xhr.open('POST', `${baseUrl}/upload`);
        const token = localStorage.getItem('token');
        if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }
        xhr.send(formData);
    };

    // Control upload concurrency (max 3 concurrent uploads)
    useEffect(() => {
        const activeUploads = uploadQueue.filter(f => f.status === 'uploading').length;
        if (activeUploads < 3) {
            const nextIdle = uploadQueue.find(f => f.status === 'idle');
            if (nextIdle) {
                startUpload(nextIdle.id, nextIdle.file);
            }
        }
    }, [uploadQueue]);

    const removeFromQueue = (id: string) => {
        setUploadQueue(prev => prev.filter(item => item.id !== id));
    };

    const clearQueue = () => {
        setUploadQueue([]);
    };

    const isUploading = uploadQueue.some(item => item.status === 'uploading');
    const hasItems = uploadQueue.length > 0;

    return (
        <div className="bg-card-background border border-border-default rounded-2xl p-6 md:p-8 shadow-md relative overflow-hidden font-sans">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-accent via-blue-500 to-cyan-400"></div>

            <div className="flex justify-between items-center mb-6">
                <h3 className="font-semibold text-xl text-text-primary flex items-center gap-2">
                    <UploadCloud className="text-accent" />
                    Upload Documents
                </h3>
                {hasItems && (
                    <button
                        onClick={clearQueue}
                        disabled={isUploading}
                        className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none rounded p-0.5 cursor-pointer font-semibold"
                        title="Clear all queue items"
                    >
                        <Trash2 size={14} />
                        Clear Queue
                    </button>
                )}
            </div>

            <div
                tabIndex={0}
                className={cn(
                    "border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center text-center transition-all duration-300 cursor-pointer shadow-inner focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none",
                    isDragging ? "border-accent bg-accent-soft scale-[1.01]" : "border-border-default bg-bg-tertiary hover:border-accent hover:bg-bg-primary"
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        fileInputRef.current?.click();
                    }
                }}
            >
                <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                    accept=".pdf,.txt,.doc,.docx"
                    multiple
                />

                <div className="w-16 h-16 bg-button-secondary border border-border-default rounded-full flex items-center justify-center mb-4 transition-transform duration-300">
                    <UploadCloud size={32} className="text-text-secondary" />
                </div>
                <p className="text-text-primary font-medium text-lg mb-1">Click to select files or drag & drop multiple files</p>
                <p className="text-text-secondary text-sm opacity-80 font-medium">PDF, TXT, DOC, DOCX files</p>
            </div>

            {hasItems && (
                <div className="mt-8 space-y-3 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
                    <div className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2 font-sans">Upload Queue</div>
                    {uploadQueue.map((item) => (
                        <div key={item.id} className="p-3.5 bg-bg-secondary border border-border-default rounded-xl flex flex-col gap-2 relative">
                            <div className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-2.5 overflow-hidden">
                                    <FileType size={16} className={cn(
                                        item.status === 'success' ? 'text-green-500' :
                                            item.status === 'error' ? 'text-red-500' : 'text-text-secondary'
                                    )} />
                                    <span className="text-sm font-semibold text-text-primary truncate max-w-[250px] sm:max-w-xs md:max-w-sm">
                                        {item.file.name}
                                    </span>
                                    <span className="text-xs text-text-secondary opacity-70 shrink-0 font-medium">
                                        ({(item.file.size / 1024 / 1024).toFixed(2)} MB)
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 shrink-0">
                                    {item.status === 'idle' && (
                                        <span className="text-xs text-text-secondary font-medium">Queued</span>
                                    )}
                                    {item.status === 'uploading' && (
                                        <div className="flex items-center gap-1.5 text-blue-500 font-semibold text-xs">
                                            <Loader2 size={12} className="animate-spin" />
                                            {item.progress}%
                                        </div>
                                    )}
                                    {item.status === 'success' && (
                                        <span className="flex items-center gap-1 text-green-500 font-bold text-xs">
                                            <CheckCircle size={12} />
                                            Indexed
                                        </span>
                                    )}
                                    {item.status === 'error' && (
                                        <span className="flex items-center gap-1 text-red-500 font-bold text-xs" title={item.error}>
                                            <AlertCircle size={12} />
                                            Failed
                                        </span>
                                    )}
                                    <button
                                        onClick={() => removeFromQueue(item.id)}
                                        disabled={item.status === 'uploading'}
                                        className="p-1 hover:bg-button-secondary rounded-lg text-text-secondary hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none cursor-pointer"
                                        title="Remove from queue"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            </div>

                            {/* Individual Progress Bar */}
                            {item.status === 'uploading' && (
                                <div className="w-full bg-bg-tertiary rounded-full h-1 overflow-hidden">
                                    <div
                                        className="bg-blue-500 h-full rounded-full transition-all duration-300"
                                        style={{ width: `${item.progress}%` }}
                                    />
                                </div>
                            )}

                            {item.status === 'error' && item.error && (
                                <p className="text-[11px] text-red-500/90 italic font-semibold font-sans">
                                    Error: {item.error}
                                </p>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
