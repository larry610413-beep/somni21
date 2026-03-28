/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Maximize,
  Minimize,
  Copy,
  Languages,
  Volume2,
  CheckCircle2,
  AlertCircle,
  Eraser,
  Clock,
  Trash2,
  Settings,
  Moon,
  Sun,
  X,
  Zap,
  Play,
  Pause,
  Lock,
  Unlock
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateTTS } from './services/gemini';
import { AlarmRecord } from './types';
import { saveAudio, getAudio, deleteAudio } from './lib/db';

// Helper: Base64 to WAV Data URI (Deprecated, kept for old records)
function base64ToWavDataURI(base64: string, sampleRate = 24000) {
  try {
    const binary = atob(base64);
    const len = binary.length;
    const buffer = new ArrayBuffer(44 + len);
    const view = new DataView(buffer);
    const writeString = (o: number, s: string) => { 
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); 
    };
    writeString(0, 'RIFF'); 
    view.setUint32(4, 36 + len, true); 
    writeString(8, 'WAVE'); 
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); 
    view.setUint16(20, 1, true); 
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); 
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); 
    view.setUint16(34, 16, true); 
    writeString(36, 'data'); 
    view.setUint32(40, len, true);
    const pcm = new Uint8Array(buffer, 44);
    for (let i = 0; i < len; i++) pcm[i] = binary.charCodeAt(i);
    const bytes = new Uint8Array(buffer);
    let binaryString = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binaryString += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
    }
    return 'data:audio/wav;base64,' + btoa(binaryString);
  } catch (e) { 
    return ""; 
  }
}

export default function App() {
  // State
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('gemini_api_key') || "");
  const [records, setRecords] = useState<AlarmRecord[]>(() => JSON.parse(localStorage.getItem('tts_alarms') || "[]"));
  const [inputText, setInputText] = useState<string>(() => localStorage.getItem('tts_draft') || "");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<{current: number, total: number} | null>(null);
  const [isNightMode, setIsNightMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activePlaybackId, setActivePlaybackId] = useState<string | null>(null);
  const [isPlayingQueue, setIsPlayingQueue] = useState(false);
  const [playlistQueue, setPlaylistQueue] = useState<AlarmRecord[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isPaused, setIsPaused] = useState(false);
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [menuData, setMenuData] = useState<{ text: string; x: number; y: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Refs
  const mainPlayerRef = useRef<HTMLAudioElement | null>(null);
  const silentTrackerRef = useRef<HTMLAudioElement | null>(null);
  const textScrollRef = useRef<HTMLDivElement | null>(null);
  const wakeLockRef = useRef<any>(null);
  const fadeIntervalRef = useRef<any>(null);
  const autoCloseTimerRef = useRef<any>(null);
  const loopTimerRef = useRef<any>(null);
  const isUserScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<any>(null);

  // Persistence & Migration
  useEffect(() => {
    const migrate = async () => {
      let needsUpdate = false;
      const updatedRecords = await Promise.all(records.map(async (r) => {
        if (r.audioBase64) {
          try {
            const binary = atob(r.audioBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'audio/wav' });
            const audioId = r.id || Date.now().toString() + Math.random();
            await saveAudio(audioId, blob);
            needsUpdate = true;
            return { ...r, audioId, audioBase64: undefined };
          } catch (e) {
            console.error("Migration failed for record", r.id, e);
            return r;
          }
        }
        return r;
      }));

      if (needsUpdate) {
        setRecords(updatedRecords);
      }
    };
    migrate();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('tts_alarms', JSON.stringify(records));
    } catch (e) {
      console.error("Failed to save records to localStorage", e);
      if (e instanceof Error && e.name === 'QuotaExceededError') {
        // Try to clear some old records if quota exceeded
        if (records.length > 10) {
          setRecords(prev => prev.slice(0, 10));
        }
      }
    }
  }, [records]);

  useEffect(() => {
    localStorage.setItem('tts_draft', inputText);
  }, [inputText]);

  useEffect(() => {
    localStorage.setItem('gemini_api_key', apiKey);
  }, [apiKey]);

  const [pullDistance, setPullDistance] = useState(0);
  const [isAtTop, setIsAtTop] = useState(true);
  const PULL_THRESHOLD = 120;

  useEffect(() => {
    const handleScroll = () => {
      setIsAtTop(window.scrollY <= 0);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleDrag = (_: any, info: any) => {
    if (isAtTop && info.offset.y > 0) {
      setPullDistance(info.offset.y);
    } else {
      setPullDistance(0);
    }
  };

  const handleDragEnd = (_: any, info: any) => {
    if (isAtTop && info.offset.y > PULL_THRESHOLD) {
      if (confirm("確定要重設應用程式嗎？這將刪除所有鬧鐘與設定。")) {
        localStorage.clear();
        window.location.reload();
      }
    }
    setPullDistance(0);
  };

  // Fullscreen Sync
  useEffect(() => {
    // Exit fullscreen if it was forced before
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // Sync Audio State
  useEffect(() => {
    const audio = mainPlayerRef.current;
    if (!audio) return;

    const handlePlay = () => {
      setIsPaused(false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    };
    const handlePause = () => {
      setIsPaused(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    };
    const handleLoadedMetadata = () => {
      if (audio) setPlaybackDuration(audio.duration);
    };
    
    let rafId: number;
    const updateTime = () => {
      if (audio && !audio.paused) {
        setCurrentPlaybackTime(audio.currentTime);
      }
      rafId = requestAnimationFrame(updateTime);
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    rafId = requestAnimationFrame(updateTime);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      cancelAnimationFrame(rafId);
    };
  }, []);

  // Media Session API for background playback
  useEffect(() => {
    if ('mediaSession' in navigator && activePlaybackId) {
      const record = records.find(r => r.id === activePlaybackId);
      if (record) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '語音鬧鐘播報',
          artist: 'AI 語音助手',
          album: record.text.slice(0, 50) + (record.text.length > 50 ? '...' : ''),
          artwork: [
            { src: 'https://picsum.photos/seed/alarm/512/512', sizes: '512x512', type: 'image/png' }
          ]
        });

        navigator.mediaSession.setActionHandler('play', () => {
          mainPlayerRef.current?.play();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          mainPlayerRef.current?.pause();
        });
        navigator.mediaSession.setActionHandler('stop', () => {
          stopPlayback();
        });
      }
    } else if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
    }
  }, [activePlaybackId, records]);

  // Clock & Alarm Checker
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(now);
      
      const hhmm = now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0');
      const seconds = now.getSeconds();

      // Only check at the start of a minute
      if (seconds === 0) {
        records.forEach(r => {
          if (r.enabled && r.time === hhmm) {
            startPlayback(r);
          }
        });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [records]);

  // Audio Unlock
  useEffect(() => {
    const unlock = () => {
      if (silentTrackerRef.current) {
        silentTrackerRef.current.play().catch(() => {});
      }
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
    document.addEventListener('touchstart', unlock, { passive: true });
    document.addEventListener('click', unlock);
    return () => {
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
  }, []);

  // Mobile Address Bar & Zoom Prevention
  useEffect(() => {
    // Hide address bar on mobile
    window.scrollTo(0, 1);
    
    // Prevent zooming on double tap
    const preventZoom = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener('touchstart', preventZoom, { passive: false });
    return () => document.removeEventListener('touchstart', preventZoom);
  }, []);

  // Wake Lock
  useEffect(() => {
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && isNightMode) {
        try {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        } catch (err) {
          console.error(`Wake Lock error: ${err}`);
        }
      } else if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };
    requestWakeLock();
  }, [isNightMode]);

  // Playback Logic
  const startPlayback = async (record: AlarmRecord, fromQueue = false) => {
    if (mainPlayerRef.current) {
      mainPlayerRef.current.pause();
      mainPlayerRef.current.currentTime = 0;
    }
    if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    if (loopTimerRef.current) clearTimeout(loopTimerRef.current);
    setIsPaused(false);
    setCurrentPlaybackTime(0);
    setPlaybackDuration(0);
    setActivePlaybackId(record.id);

    if (!fromQueue) {
      setPlaylistQueue([]);
      setIsPlayingQueue(false);
    }

    let audioUrl = "";
    if (record.audioId) {
      const blob = await getAudio(record.audioId);
      if (blob) {
        audioUrl = URL.createObjectURL(blob);
      }
    } else if (record.audioBase64) {
      audioUrl = base64ToWavDataURI(record.audioBase64);
    }

    if (!audioUrl || !mainPlayerRef.current) {
      if (activePlaybackId === record.id) setActivePlaybackId(null);
      return;
    }

    const audio = mainPlayerRef.current;
    audio.src = audioUrl;
    audio.playbackRate = 0.85;
    audio.preservesPitch = true;
    audio.load();

    // Fade In
    const targetVolume = record.volume || 0.3;
    audio.volume = targetVolume / 3;
    let step = 0;
    const fadeSteps = 50;
    const stepVol = (targetVolume - audio.volume) / fadeSteps;
    
    fadeIntervalRef.current = setInterval(() => {
      step++;
      if (audio && !audio.paused && step <= fadeSteps) {
        audio.volume = Math.min(targetVolume, audio.volume + stepVol);
      } else if (step > fadeSteps) {
        clearInterval(fadeIntervalRef.current);
      }
    }, 100);

    let repeatCount = 0;
    const playLoop = () => {
      audio.play().catch(e => console.warn("Playback blocked", e));
      
      audio.onended = () => {
        repeatCount++;
        const maxRepeats = record.repeats || 1;
        
        if (repeatCount < maxRepeats) {
          loopTimerRef.current = setTimeout(playLoop, (record.interval || 5) * 1000);
        } else {
          if (fromQueue) {
            // Immediately clear active ID to trigger the next one in queue
            setActivePlaybackId(null);
          } else {
            // Single play: keep text visible for 10s then close
            autoCloseTimerRef.current = setTimeout(() => {
              setActivePlaybackId(null);
            }, 10000);
          }
        }
      };
    };

    playLoop();
  };

  const stopPlayback = () => {
    if (mainPlayerRef.current) {
      mainPlayerRef.current.pause();
      mainPlayerRef.current.currentTime = 0;
    }
    if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    if (loopTimerRef.current) clearTimeout(loopTimerRef.current);
    setActivePlaybackId(null);
    setIsPlayingQueue(false);
    setPlaylistQueue([]);
    setIsPaused(false);
    setCurrentPlaybackTime(0);
    setPlaybackDuration(0);
  };

  const togglePlay = async (record: AlarmRecord) => {
    if (activePlaybackId === record.id) {
      stopPlayback();
    } else {
      await startPlayback(record);
    }
  };

  const speakText = async (text: string, volume: number = 1, isSelection: boolean = false) => {
    if (!text) return;
    
    // Use Gemini for natural voice if key exists, otherwise fallback to browser
    if (apiKey) {
      try {
        const blob = await generateTTS(text, apiKey, isSelection);
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = volume;
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play();
        return;
      } catch (err) {
        console.warn("Gemini TTS failed, falling back to browser TTS", err);
      }
    }

    // Browser Fallback
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = volume;
    const voices = window.speechSynthesis.getVoices();
    const zhVoice = voices.find(v => v.lang.includes('zh-TW') || v.lang.includes('zh-CN'));
    if (zhVoice) utterance.voice = zhVoice;
    window.speechSynthesis.speak(utterance);
  };

  const handleSpeakSelection = () => {
    const selection = window.getSelection()?.toString().trim();
    if (!selection) {
      return;
    }
    
    // Try to get volume from active playback record
    const activeRecord = records.find(r => r.id === activePlaybackId);
    const volume = activeRecord ? activeRecord.volume : 1;
    
    speakText(selection, volume, true);
  };

  // Generation
  const handleGenerate = async () => {
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    if (!inputText.trim() || isGenerating) return;

    setIsGenerating(true);
    setGenerationProgress(null);
    try {
      const blob = await generateTTS(
        inputText, 
        apiKey, 
        false, 
        (current, total) => setGenerationProgress({ current, total })
      );
      
      const audioId = Date.now().toString();
      await saveAudio(audioId, blob);
      
      const durationSec = Math.ceil(blob.size / 48000); // Approximate for 24kHz 16-bit mono
      
      const newRecord: AlarmRecord = {
        id: audioId,
        text: inputText,
        audioId,
        durationSec,
        time: "0000",
        enabled: false,
        volume: 0.3,
        repeats: 3,
        interval: 5,
        locked: true
      };

      setRecords(prev => [newRecord, ...prev]);
      setInputText("");
    } catch (err: any) {
      console.error("Generation error:", err);
      let msg = err.message || '未知錯誤';
      if (msg.includes("429") || msg.includes("quota") || msg.includes("Quota")) {
        msg = "Google API 次數達到上限 (Quota Exceeded)。請稍候再試，或更換另一個 Google 帳號的 API Key。";
      }
      alert(`生成失敗: ${msg}`);
    } finally {
      setIsGenerating(false);
      setGenerationProgress(null);
    }
  };

  const handleAllPlay = () => {
    const offAlarms = [...records].filter(r => !r.enabled).sort((a, b) => a.time.localeCompare(b.time));
    if (offAlarms.length === 0) {
      alert("目前沒有設定為 OFF 的鬧鐘可供播放！");
      return;
    }
    setPlaylistQueue(offAlarms);
    setIsPlayingQueue(true);
  };

  // Queue Effect
  useEffect(() => {
    if (isPlayingQueue && !activePlaybackId && playlistQueue.length > 0) {
      const next = playlistQueue[0];
      setPlaylistQueue(prev => prev.slice(1));
      startPlayback(next, true);
    }
  }, [isPlayingQueue, activePlaybackId, playlistQueue]);

  // Render Helpers
  const sortedRecords = useMemo(() => {
    return [...records].sort((a, b) => a.time.localeCompare(b.time));
  }, [records]);

  const activeRecord = useMemo(() => {
    return records.find(r => r.id === activePlaybackId);
  }, [records, activePlaybackId]);

  const lineRanges = useMemo(() => {
    if (!activeRecord) return [];
    const lines = activeRecord.text.split('\n');
    let charCount = 0;

    return lines.map(line => {
      const start = charCount;
      charCount += line.length + 1;
      return { start, end: charCount };
    });
  }, [activeRecord]);

  const currentPos = useMemo(() => {
    if (!activeRecord || !playbackDuration) return 0;
    return (currentPlaybackTime / playbackDuration) * activeRecord.text.length;
  }, [currentPlaybackTime, activeRecord, playbackDuration]);

  const currentLineIndex = useMemo(() => {
    if (!lineRanges.length) return -1;
    return lineRanges.findIndex(range => currentPos >= range.start && currentPos < range.end);
  }, [lineRanges, currentPos]);

  // Auto-scroll to active line
  useEffect(() => {
    if (activePlaybackId && !isUserScrollingRef.current && currentLineIndex !== -1) {
      // Use a small timeout to ensure the DOM has updated the .active-line class
      const timer = setTimeout(() => {
        const container = textScrollRef.current;
        const activeEl = container?.querySelector('.active-line') as HTMLElement;
        if (activeEl && container) {
          const elementTop = activeEl.offsetTop;
          const elementHeight = activeEl.offsetHeight;
          const containerHeight = container.offsetHeight;
          
          // 將當前行定位在距離底部約 30px 的位置，確保藍色底線清晰可見且不被遮擋
          const offsetFromBottom = 30;
          const targetScrollTop = elementTop + elementHeight - containerHeight + offsetFromBottom;
          
          container.scrollTo({
            top: Math.max(0, targetScrollTop),
            behavior: 'smooth'
          });
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [currentLineIndex, activePlaybackId]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  return (
    <motion.div 
      drag="y"
      dragListener={isAtTop}
      dragDirectionLock
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.3}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      style={{ y: pullDistance * 0.4 }}
      className="h-[100dvh] w-full bg-black text-white font-light overflow-hidden relative flex flex-col"
    >
      {/* Pull to Reset Indicator */}
      <div 
        className="absolute top-0 left-0 w-full flex items-center justify-center pointer-events-none z-[1000] overflow-hidden"
        style={{ height: Math.min(pullDistance, 200) }}
      >
        <div 
          className="flex flex-col items-center gap-2 transition-opacity"
          style={{ opacity: Math.min(1, pullDistance / 60) }}
        >
          <div className={`p-3 rounded-full bg-white/5 border border-white/10 transition-all ${pullDistance > PULL_THRESHOLD ? 'scale-110 bg-red-500/20 border-red-500/50' : ''}`}>
            <Eraser className={`w-6 h-6 transition-colors ${pullDistance > PULL_THRESHOLD ? 'text-red-500' : 'text-white/40'}`} />
          </div>
          <span className={`text-[10px] uppercase tracking-[0.2em] font-bold transition-colors ${pullDistance > PULL_THRESHOLD ? 'text-red-500' : 'text-white/40'}`}>
            {pullDistance > PULL_THRESHOLD ? "放開以重設全部資料" : "繼續下拉以重設"}
          </span>
        </div>
      </div>

      {/* Hidden Audio Elements */}
      <audio ref={silentTrackerRef} loop playsinline src="data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA" className="hidden" />
      <audio ref={mainPlayerRef} playsinline className="hidden" />

      {/* Night Mode Overlay */}
      <AnimatePresence>
        {isNightMode && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[400] bg-black flex flex-col items-center justify-center pt-16 px-6 pb-6 text-center h-dvh"
          >
            <div className="absolute top-16 flex flex-col items-center gap-3">
              <AlertCircle className="text-amber-500 w-8 h-8" />
              <p className="text-amber-500/80 text-xs md:text-sm tracking-widest leading-relaxed max-w-[280px]">
                請保持充電並不要關閉螢幕。<br/>
                畫面已進入省電模式，時間到一定會響起。
              </p>
            </div>
            
            <div className="text-[3.5rem] md:text-[5rem] font-black text-indigo-500/50 font-mono tracking-tighter mt-10 tabular-nums">
              {currentTime.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}
            </div>

            <div className="mt-8 flex flex-col items-center gap-4">
              {sortedRecords.filter(r => r.enabled).slice(0, 3).map(r => (
                <div key={r.id} className="flex items-center gap-2 text-2xl text-white/50 font-mono tracking-wider">
                  <Clock className="w-5 h-5 opacity-70" />
                  {r.time.slice(0,2)}:{r.time.slice(2,4)}
                </div>
              ))}
              {sortedRecords.filter(r => r.enabled).length === 0 && (
                <div className="text-white/30 italic text-sm tracking-widest uppercase">無啟動中的鬧鐘</div>
              )}
            </div>
            
            <button 
              onClick={() => setIsNightMode(false)}
              className="absolute bottom-10 px-8 py-4 border border-white/20 text-white/60 rounded-full text-sm font-bold tracking-widest hover:bg-white/10"
            >
              退出夜間模式
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="w-full h-full max-w-3xl mx-auto px-3 pt-3 pb-4 flex flex-col gap-3 relative overflow-y-auto">
        
        {/* 1. Input / Playback Section */}
        <div className="relative flex-[1.4] landscape:flex-[2.5] min-h-[45vh] shrink-0 flex flex-col">
          <AnimatePresence mode="wait">
            {!activePlaybackId ? (
              <motion.div 
                key="input"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="bg-[#1a1a1a] rounded-[24px] border border-white/10 overflow-hidden shadow-2xl flex flex-col h-full"
              >
                <div className="relative w-full flex-1 bg-black">
                  <textarea 
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    className="absolute inset-0 w-full h-full p-4 bg-transparent focus:outline-none resize-none text-xl text-white/80 placeholder:text-white/10 font-normal leading-relaxed tracking-wide" 
                    placeholder="輸入文字...&#10;支援：小美：你好&#10;支援：小明：你好"
                  />
                </div>
                
                <div className="p-1.5 bg-white/5 border-t border-white/10 flex items-center justify-between gap-1.5 shrink-0">
                  <button 
                    onClick={handleAllPlay}
                    className="px-2 py-1.5 bg-orange-600/20 rounded-lg border border-orange-500/30 text-[12px] font-bold text-orange-300 min-w-[60px] text-center flex items-center justify-center gap-1 hover:bg-orange-600 hover:text-white transition-colors"
                  >
                    <Play className="w-3 h-3" /> All
                  </button>
                  
                  <button 
                    onClick={() => {
                      if(confirm('確定要清空文字嗎？')) setInputText("");
                    }}
                    className="flex-1 py-1.5 rounded-lg bg-black border border-white/10 text-white/60 flex justify-center items-center h-9 text-xs font-bold gap-1 active:bg-white/10"
                  >
                    <Eraser className="w-3 h-3" /> 清空
                  </button>

                  <button 
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    className="flex-[2] py-1.5 rounded-lg text-[13px] font-bold bg-zinc-200 text-zinc-800 active:scale-95 transition-all flex items-center justify-center gap-1.5 h-9 disabled:opacity-50"
                  >
                    {isGenerating ? (
                      <div className="flex items-center gap-2">
                        <div className="animate-spin"><Zap className="w-4 h-4" /></div>
                        <span>{generationProgress ? `處理中 ${generationProgress.current}/${generationProgress.total}` : "連線中..."}</span>
                      </div>
                    ) : (
                      <>
                        <Zap className="w-4 h-4" />
                        <span>生成</span>
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="playback"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05 }}
                className="relative h-full bg-[#1a1a1a] rounded-[24px] border border-white/10 overflow-hidden shadow-2xl flex flex-col"
              >
                <button 
                  onClick={stopPlayback}
                  className="absolute top-2 right-2 z-50 p-2 text-white/50 hover:text-white transition-colors bg-black/20 rounded-full"
                >
                  <X className="w-6 h-6" />
                </button>

                {/* Background Play/Pause Status Icon */}
                <div className="absolute right-2 top-1/2 -translate-y-1/2 z-0 opacity-40 pointer-events-none w-[52px] h-[52px] flex items-center justify-center">
                  {isPaused ? (
                    <Play className="w-[24px] h-[24px] text-white" />
                  ) : (
                    <Pause className="w-[24px] h-[24px] text-white" />
                  )}
                </div>

                <div 
                  ref={textScrollRef}
                  className="flex-1 py-16 pl-3 pr-6 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-thumb-white/20 relative cursor-pointer"
                  onScroll={() => {
                    isUserScrollingRef.current = true;
                    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
                    scrollTimeoutRef.current = setTimeout(() => { 
                      isUserScrollingRef.current = false; 
                    }, 6000);
                  }}
                  onTouchStart={() => {
                    isUserScrollingRef.current = true;
                    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
                    scrollTimeoutRef.current = setTimeout(() => { 
                      isUserScrollingRef.current = false; 
                    }, 6000);
                  }}
                  onMouseDown={() => {
                    isUserScrollingRef.current = true;
                    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
                    scrollTimeoutRef.current = setTimeout(() => { 
                      isUserScrollingRef.current = false; 
                    }, 6000);
                  }}
                  onClick={(e) => {
                    if (isPaused) {
                      const selection = window.getSelection()?.toString();
                      if (selection) {
                        setMenuData({ text: selection, x: e.clientX, y: e.clientY });
                        return;
                      }
                    }
                    setMenuData(null);

                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    if (x < rect.width / 2) {
                      // Left: Rewind 3s
                      if (mainPlayerRef.current) {
                        mainPlayerRef.current.currentTime = Math.max(0, mainPlayerRef.current.currentTime - 3);
                      }
                    } else {
                      // Right: Toggle Play/Pause
                      if (mainPlayerRef.current) {
                        if (mainPlayerRef.current.paused) mainPlayerRef.current.play();
                        else mainPlayerRef.current.pause();
                      }
                    }
                  }}
                >
                  <div className="text-[20px] landscape:text-[22px] font-normal leading-relaxed text-left whitespace-pre-wrap break-words select-text">
                    {activeRecord?.text.split('\n').map((line, i) => {
                      const match = line.match(/^([^:：]+)[:：]\s*(.*)$/);
                      const range = lineRanges[i];
                      const isActive = currentPos >= range?.start && currentPos < range?.end;

                      if (match) {
                        const name = match[1].trim();
                        const content = match[2].trim().replace(/ \.\.\. /g, '。');
                        return (
                          <div key={i} className={`mb-8 last:mb-0 ${isActive ? 'active-line' : ''}`}>
                            <div className="font-normal text-gray-400/90 mb-1">{name}:</div>
                            <div className={`relative inline-block transition-all duration-300 text-white/90`}>
                              {content}
                              {isActive && (
                                <motion.div 
                                  layoutId="underline"
                                  className="absolute -bottom-2 left-0 h-0.5 bg-blue-700 w-full rounded-full"
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                />
                              )}
                            </div>
                          </div>
                        );
                      }
                      return line.trim() ? (
                        <div key={i} className={`mb-6 last:mb-0 relative inline-block transition-all duration-300 text-white/90 ${isActive ? 'active-line' : ''}`}>
                          {line.replace(/ \.\.\. /g, '。')}
                          {isActive && (
                            <motion.div 
                              layoutId="underline"
                              className="absolute -bottom-2 left-0 h-0.5 bg-blue-700 w-full rounded-full"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                            />
                          )}
                        </div>
                      ) : null;
                    })}
                  </div>

                  {/* Pause Menu */}
                  <AnimatePresence>
                    {menuData && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 10 }}
                        style={{ left: Math.min(window.innerWidth - 160, Math.max(10, menuData.x - 80)), top: menuData.y - 60 }}
                        className="fixed z-[100] bg-black/90 backdrop-blur-xl border border-white/20 rounded-xl shadow-2xl flex items-center gap-1 p-1"
                      >
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(`https://translate.google.com/?sl=auto&tl=zh-TW&text=${encodeURIComponent(menuData.text)}&op=translate`, '_blank');
                            setMenuData(null);
                          }}
                          className="p-2 hover:bg-white/10 rounded-lg text-white/80 flex flex-col items-center gap-0.5"
                        >
                          <Languages className="w-4 h-4" />
                          <span className="text-[9px]">翻譯</span>
                        </button>
                        <div className="w-px h-6 bg-white/10 mx-0.5" />
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(menuData.text);
                            setMenuData(null);
                          }}
                          className="p-2 hover:bg-white/10 rounded-lg text-white/80 flex flex-col items-center gap-0.5"
                        >
                          <Copy className="w-4 h-4" />
                          <span className="text-[9px]">複製</span>
                        </button>
                        <div className="w-px h-6 bg-white/10 mx-0.5" />
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            const activeRecord = records.find(r => r.id === activePlaybackId);
                            speakText(menuData.text, activeRecord?.volume || 1, true);
                            setMenuData(null);
                          }}
                          className="p-2 hover:bg-white/10 rounded-lg text-white/80 flex flex-col items-center gap-0"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                          <span className="text-[9px]">發音</span>
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="absolute bottom-2 right-2 z-50 flex flex-col gap-2">
                  <button 
                    onClick={handleSpeakSelection}
                    className="w-[44px] h-[44px] flex items-center justify-center bg-transparent rounded-full hover:bg-white/10 active:scale-95 transition-all"
                    title="發音選取文字"
                  >
                    <Volume2 className="w-[20px] h-[20px] text-white/80" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 2. Alarm List */}
        <div className="flex flex-col gap-2 w-full pr-1 pb-2">
          {sortedRecords.map(r => (
            <div 
              key={r.id} 
              className={`bg-[#1a1a1a] rounded-[16px] border p-1 flex flex-col gap-1 transition-all ${r.enabled ? 'border-white/20 shadow-md' : 'border-white/5 opacity-80'}`}
            >
              <div className="flex items-center gap-0.5 w-full">
                <input 
                  type="text" 
                  inputmode="numeric" 
                  maxlength={4} 
                  value={r.time} 
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                    setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, time: val } : rec));
                  }}
                  onBlur={(e) => {
                    const val = e.target.value.padStart(4, '0');
                    setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, time: val } : rec));
                  }}
                  className="w-11 h-8 bg-black border border-white/10 rounded-lg text-white font-mono text-center outline-none focus:border-indigo-500 text-[15px] tracking-wider font-bold shrink-0" 
                />
                
                <button 
                  onClick={() => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, enabled: !rec.enabled } : rec))}
                  className={`w-7 h-5.5 ml-1 shrink-0 rounded-md font-bold text-[8px] transition-all ${r.enabled ? 'bg-green-500 text-white' : 'bg-white/10 text-white/30'}`}
                >
                  {r.enabled ? 'ON' : 'OFF'}
                </button>

                <div className="flex-1"></div> 

                <div className="flex items-center bg-black border border-white/10 rounded-lg w-9 h-7 shrink-0">
                  <input 
                    type="number" 
                    min="1" 
                    value={r.repeats} 
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, repeats: parseInt(e.target.value) || 1 } : rec))}
                    className="bg-transparent text-indigo-300 font-bold w-full text-center outline-none text-[13px]" 
                  />
                </div>

                <div className="flex items-center bg-black border border-white/10 rounded-lg w-14 h-8 px-1 gap-0.5 shrink-0">
                  <input 
                    type="number" 
                    min="0" 
                    value={r.interval} 
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, interval: parseInt(e.target.value) || 0 } : rec))}
                    className="bg-transparent text-amber-300 font-bold w-full text-center outline-none text-[13px]" 
                  />
                  <span className="text-[8px] text-white/40">秒</span>
                </div>

                <button 
                  onClick={() => {
                    if(activePlaybackId === r.id) stopPlayback();
                    if (r.audioId) deleteAudio(r.audioId);
                    setRecords(prev => prev.filter(rec => rec.id !== r.id));
                  }}
                  className="w-7 h-7 bg-white/10 rounded-lg flex items-center justify-center hover:bg-white/20 transition-colors opacity-90 hover:opacity-100 text-sm shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5 text-white/60" />
                </button>
              </div>

              <div className="bg-black/90 rounded-lg p-1.5 flex items-center gap-2 border border-white/5 shadow-inner relative overflow-hidden">
                {activePlaybackId === r.id && (
                  <motion.div 
                    layoutId="progress"
                    className="absolute bottom-0 left-0 h-0.5 bg-indigo-500 w-full"
                    initial={{ scaleX: 0, originX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: r.durationSec, ease: "linear" }}
                  />
                )}
                
                <div className="flex items-center gap-1 shrink-0 z-10 w-[4rem]">
                  <button 
                    onClick={() => togglePlay(r)}
                    className={`flex items-center justify-center transition-all bg-transparent hover:scale-110 active:scale-95 ${activePlaybackId === r.id ? 'text-green-500 opacity-100 drop-shadow-[0_0_5px_rgba(34,197,94,0.5)]' : 'text-orange-500 opacity-80 hover:opacity-100'}`}
                  >
                    {activePlaybackId === r.id ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
                  </button>
                  <span className="text-[10px] font-bold text-white drop-shadow-sm font-mono tracking-tighter">{r.durationSec}s</span>
                </div>

                <div className="flex-1 min-w-0 text-[9px] text-white/60 truncate font-light z-10 leading-tight">
                  {r.text.replace(/\n/g, ' ')}
                </div>

                <div className="w-24 sm:w-32 flex flex-col gap-0 shrink-0 z-10">
                  <div className="flex items-center gap-0.5">
                    <Volume2 className="w-3 h-3 text-white/40" />
                    <input 
                      type="range" 
                      min="0" 
                      max="1" 
                      step="0.01" 
                      value={r.volume} 
                      disabled={r.locked}
                      onChange={(e) => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, volume: parseFloat(e.target.value) } : rec))}
                      className={`flex-1 h-1 bg-white/10 rounded-lg appearance-none accent-white ${r.locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`} 
                    />
                  </div>
                  <div className="flex justify-between items-center text-[8px] font-bold text-white/50 px-1 font-mono tracking-tighter">
                    <span>0</span><span>2</span><span>4</span><span>6</span><span>8</span>
                    <button 
                      onClick={() => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, locked: !rec.locked } : rec))}
                      className={`ml-1 transition-colors ${r.locked ? 'text-amber-500' : 'text-white/30 hover:text-white/60'}`}
                    >
                      {r.locked ? <Lock className="w-2.5 h-2.5" /> : <Unlock className="w-2.5 h-2.5" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
          {/* 3. Bottom Controls */}
          <div className="flex gap-1.5 shrink-0 mt-3 pb-6">
            <div className="flex-1 flex items-center justify-between px-3 py-1.5 bg-[#1a1a1a] rounded-xl border border-white/5">
              <div className="flex items-center gap-2">
                <button 
                  onClick={toggleFullscreen}
                  className="p-1.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white/80 transition-colors flex items-center justify-center"
                  title={isFullscreen ? "退出全螢幕" : "全螢幕模式"}
                >
                  {isFullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
                </button>
                <div className="flex items-center gap-2 text-[10px] text-green-500/80 tracking-widest font-bold">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>就緒 ({records.filter(r => r.enabled).length}項)</span>
                </div>
              </div>
              <button 
                onClick={() => setShowSettings(true)}
                className="px-3 py-1 bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 rounded-lg hover:bg-indigo-600 hover:text-white transition-colors text-xs font-bold flex items-center gap-1"
              >
                <Settings className="w-3 h-3" /> ikey
              </button>
            </div>
            <button 
              onClick={() => setIsNightMode(true)}
              className="px-4 py-1.5 rounded-xl border bg-[#1a1a1a] border-white/5 text-white/60 hover:text-white text-xs font-bold flex items-center gap-1"
            >
              <Moon className="w-3 h-3 text-amber-400" /> 夜間
            </button>
          </div>
        </div>

      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[500] bg-black/95 flex flex-col items-center justify-center backdrop-blur-xl px-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl relative"
            >
              <h3 className="text-white text-lg font-bold mb-2">設定 API Key</h3>
              <p className="text-white/40 text-xs mb-4">
                請輸入 Google Gemini API 金鑰。<br/>
                <span className="text-amber-500">注意：請確保金鑰未設定「網站限制」(None)。</span>
              </p>
              
              <div className="relative w-full mb-4">
                <input 
                  type="password" 
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full bg-black border border-white/20 rounded-xl px-4 py-3 text-white outline-none focus:border-indigo-500 font-mono text-sm" 
                  placeholder="AIzaSy..."
                />
              </div>

              <div className="flex flex-col gap-2">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="w-full py-3 bg-indigo-600 text-white rounded-xl font-bold active:scale-95 transition-all text-sm"
                >
                  儲存並開始
                </button>
                <button 
                  onClick={() => {
                    if (confirm("確定要重設應用程式嗎？這將刪除所有鬧鐘與設定。")) {
                      localStorage.clear();
                      window.location.reload();
                    }
                  }}
                  className="w-full py-3 bg-red-500/20 text-red-500 rounded-xl text-sm font-medium hover:bg-red-500/30 transition-all"
                >
                  重設應用程式 (清除所有資料)
                </button>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="w-full py-3 bg-white/5 text-white/40 rounded-xl text-sm hover:text-white"
                >
                  取消
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
