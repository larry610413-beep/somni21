import { GoogleGenAI, Modality } from "@google/genai";

const SPEAKER_MAP: Record<string, string> = {
  '小美': 'Callirrhoe',
  '女生': 'Callirrhoe',
  '小明': 'Puck',
  '男生': 'Puck',
  '老師': 'Kore'
};

const VOICE_POOL = ['Callirrhoe', 'Puck', 'Kore', 'Aoede', 'Charon'];
const DEFAULT_VOICE = 'Kore';

export async function generateTTS(text: string, apiKey: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  
  const speakers = new Set<string>();
  text.split('\n').forEach(line => {
    const m = line.match(/^([^：:\s]+)[：:]/);
    if (m) speakers.add(m[1]);
  });

  // 增加跟讀停頓
  let processedText = text.replace(/([。！？!?])/g, '$1 ......... ');
  processedText = processedText.replace(/\n+/g, '\n ......... \n');

  const speakerArray = Array.from(speakers);
  let speechConfig: any;

  if (speakerArray.length > 1) {
    speechConfig = {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: speakerArray.map((n, i) => ({
          speaker: n,
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: SPEAKER_MAP[n] || VOICE_POOL[i % 5]
            }
          }
        }))
      }
    };
  } else if (speakerArray.length === 1) {
    speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: SPEAKER_MAP[speakerArray[0]] || DEFAULT_VOICE
        }
      }
    };
  } else {
    speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: DEFAULT_VOICE
        }
      }
    };
  }

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: processedText }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: speechConfig
    },
  });

  const audioData = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
  if (!audioData) {
    throw new Error("無法從 API 獲取音訊資料");
  }

  return audioData;
}
