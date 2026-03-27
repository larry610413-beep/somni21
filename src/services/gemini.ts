import { GoogleGenAI, Modality } from "@google/genai";

const SPEAKER_MAP: Record<string, string> = {
  '小美': 'Callirrhoe',
  '女生': 'Callirrhoe',
  '小明': 'Puck',
  '男生': 'Puck',
  '老師': 'Kore'
};

const VOICE_POOL = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];
const DEFAULT_VOICE = 'Zephyr';

function createWavBlob(pcmData: Uint8Array, sampleRate = 24000): Blob {
  // Check if it's already a WAV file (starts with RIFF)
  if (pcmData.length > 4 && 
      pcmData[0] === 0x52 && pcmData[1] === 0x49 && 
      pcmData[2] === 0x46 && pcmData[3] === 0x46) {
    return new Blob([pcmData], { type: 'audio/wav' });
  }

  const len = pcmData.length;
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
  pcm.set(pcmData);
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function generateTTS(text: string, apiKey: string, isSelection: boolean = false, onProgress?: (current: number, total: number) => void): Promise<Blob> {
  const ai = new GoogleGenAI({ apiKey });
  
  // 更嚴格的分段處理
  const MAX_CHUNK_SIZE = 400;
  const chunks: { text: string; isParagraphEnd: boolean }[] = [];
  
  // 先按段落切分
  const paragraphs = text.split('\n');
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    
    const startIndex = chunks.length;
    if (p.length <= MAX_CHUNK_SIZE) {
      chunks.push({ text: p, isParagraphEnd: true });
    } else {
      // 段落太長，按句子切分
      const sentences = p.split(/([。！？])/);
      let currentChunk = "";
      for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        if ((currentChunk + s).length > MAX_CHUNK_SIZE && currentChunk) {
          chunks.push({ text: currentChunk, isParagraphEnd: false });
          currentChunk = "";
        }
        currentChunk += s;
      }
      if (currentChunk) {
        // 如果句子還是太長，強制按字數切分
        if (currentChunk.length > MAX_CHUNK_SIZE) {
          for (let i = 0; i < currentChunk.length; i += MAX_CHUNK_SIZE) {
            chunks.push({ text: currentChunk.substring(i, i + MAX_CHUNK_SIZE), isParagraphEnd: false });
          }
        } else {
          chunks.push({ text: currentChunk, isParagraphEnd: false });
        }
      }
      if (chunks.length > startIndex) {
        chunks[chunks.length - 1].isParagraphEnd = true;
      }
    }
  }

  if (chunks.length === 0 && text.trim()) {
    chunks.push({ text: text.trim(), isParagraphEnd: true });
  }

  const audioChunks: Uint8Array[] = [];
  
  // Generate 2 seconds of silence (24000 sample rate, 16-bit mono = 2 bytes per sample)
  const silenceBytesLength = 24000 * 2 * 2;
  const silenceWavData = new Uint8Array(silenceBytesLength); 
  
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i + 1, chunks.length);
    
    const chunkText = chunks[i].text.trim();
    const isParagraphEnd = chunks[i].isParagraphEnd;
    if (!chunkText) continue;

    const speakers = new Set<string>();
    chunkText.split('\n').forEach(line => {
      const m = line.match(/^([^：:\s]+)[：:]/);
      if (m) speakers.add(m[1]);
    });

    let processedText = chunkText;
    if (!isSelection) {
      processedText = chunkText.replace(/([。！？!?])/g, '$1 ');
      processedText = processedText.replace(/\n+/g, '\n');
    }

    const finalPrompt = isSelection 
      ? `Please pronounce this text clearly and naturally: ${processedText}`
      : processedText;

    const speakerArray = Array.from(speakers);
    let speechConfig: any;

    if (speakerArray.length > 1) {
      speechConfig = {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakerArray.map((n, idx) => ({
            speaker: n,
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: SPEAKER_MAP[n] || VOICE_POOL[idx % 5]
              }
            }
          }))
        }
      };
    } else {
      const voiceName = speakerArray.length === 1 
        ? (SPEAKER_MAP[speakerArray[0]] || DEFAULT_VOICE)
        : DEFAULT_VOICE;
        
      speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName
          }
        }
      };
    }

    try {
      // 增加小延遲以避免 API 頻率限制
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: finalPrompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: speechConfig
        },
      });

      if (!response.candidates?.[0]?.content?.parts) {
        throw new Error("API 回應內容為空");
      }

      const audioPart = response.candidates[0].content.parts.find(p => p.inlineData);
      const audioBase64 = audioPart?.inlineData?.data;
      
      if (!audioBase64) {
        throw new Error("無法獲取音訊資料");
      }

      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; j++) {
        bytes[j] = binary.charCodeAt(j);
      }
      
      // If it has a RIFF header, strip it so we can safely concatenate raw PCM
      let pcmBytes = bytes;
      if (bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        pcmBytes = bytes.slice(44);
      }
      
      audioChunks.push(pcmBytes);

      // 插入段落停頓 (如果不是最後一段，並且標記為段落結尾，且非選取發音模式)
      if (isParagraphEnd && !isSelection && i < chunks.length - 1) {
        audioChunks.push(silenceWavData);
      }
    } catch (err: any) {
      console.error(`Chunk ${i + 1} failed:`, err);
      throw new Error(`第 ${i + 1} 段生成失敗: ${err.message || '未知錯誤'}`);
    }
  }

  if (audioChunks.length === 0) {
    throw new Error("未生成任何音訊片段");
  }

  const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combinedAudio = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    combinedAudio.set(chunk, offset);
    offset += chunk.length;
  }

  return createWavBlob(combinedAudio);
}
