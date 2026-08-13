import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import path from "path";
import fs from "fs";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. ROBUST FONT REGISTRATION ---
// On Vercel, process.cwd() is the root of your project
const fontsDir = path.resolve(process.cwd(), "fonts");
const fontFiles = [
    { file: "NotoSansArabic-Regular.ttf", name: "NotoArabic" },
    { file: "NotoSansCJKsc-Regular.otf", name: "NotoSansCJK" },
    { file: "NotoSans-Regular.ttf", name: "NotoSans" }
];

fontFiles.forEach(f => {
    const p = path.join(fontsDir, f.file);
    if (fs.existsSync(p)) {
        GlobalFonts.registerFromPath(p, f.name);
        console.log(`✅ Font Loaded: ${f.name}`);
    } else {
        console.error(`❌ Font missing at: ${p}`);
    }
});

// --- 2. LANGUAGE HELPERS ---
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "id": "id", "ru": "ru", "de": "de" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

function toOCRLang(l) {
    const dict = { "zh": "chs", "jp": "jpn", "ko": "kor", "fra": "fre", "spa": "spa", "ara": "ara" };
    let s = String(l).toLowerCase();
    return dict[s] || "eng";
}

// --- 3. TRANSLATION & OCR ---
async function translateWithGoogle(txt, f, t) {
    try {
        let src = (f === "auto" || f === "au") ? "auto" : toGoogleLang(f);
        let tgt = toGoogleLang(t);
        const params = new URLSearchParams({ client: 'gtx', sl: src, tl: tgt, dt: 't', q: txt });
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
            timeout: 10000,
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (r.data && r.data[0]) return r.data[0].map(s => s[0]).join("").trim();
        return txt;
    } catch (e) { return txt; }
}

async function extractTextWithOCR(imageBuffer, fromLang) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld'); 
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', toOCRLang(fromLang));
        formData.append('OCREngine', '2');
        formData.append('isOverlayRequired', 'true');

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 60000 
        });

        if (response.data && response.data.OCRExitCode === 1) {
            return {
                text: response.data.ParsedResults[0].ParsedText.trim(),
                lines: response.data.ParsedResults[0].TextOverlay.Lines
            };
        }
        return null;
    } catch (e) { return null; }
}

// --- 4. MASTER RENDERING ENGINE ---
async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // A. Background Sampling
        const sampleX = Math.max(0, x - 2);
        const sampleY = Math.max(0, y - 2);
        const pixelData = ctx.getImageData(sampleX, sampleY, 1, 1).data;
        ctx.fillStyle = `rgb(${pixelData[0]},${pixelData[1]},${pixelData[2]})`;
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2); 

        // B. Color Contrast Logic
        const brightness = (pixelData[0] * 0.299 + pixelData[1] * 0.587 + pixelData[2] * 0.114);
        ctx.fillStyle = brightness > 125 ? 'black' : 'white';

        // C. Font & Language Logic
        let fontSize = Math.floor(h * 0.82); 
        const isArabic = /[\u0600-\u06FF]/.test(text);
        const fontChain = '"NotoArabic", "NotoSansCJK", "NotoSans", sans-serif';
        
        ctx.font = `${fontSize}px ${fontChain}`;
        ctx.textBaseline = 'middle';

        if (isArabic) {
            // ARABIC SPECIAL: Fixes shaping and punctuation placement
            ctx.direction = 'rtl'; 
            ctx.textAlign = 'right';
            
            let measured = ctx.measureText(text).width;
            if (measured > w) {
                const shrunkSize = Math.floor(fontSize * (w / measured));
                ctx.font = `${shrunkSize}px ${fontChain}`;
            }
            // Draw from right to left
            ctx.fillText(text, x + w, y + (h / 2)); 
        } else {
            // CJK & LATIN: Normal behavior
            ctx.direction = 'ltr';
            ctx.textAlign = 'left';
            ctx.fillText(text, x, y + (h / 2), w); 
        }
    }

    return canvas.toBuffer('image/jpeg');
}

// --- 5. API ENDPOINT ---
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });
    const { from = "auto", to = "zh" } = req.body;

    try {
        const ocr = await extractTextWithOCR(req.file.buffer, from);
        if (!ocr || !ocr.lines) throw new Error("OCR Failed");

        const resRegions = [];
        for (const line of ocr.lines) {
            const dstText = await translateWithGoogle(line.LineText, from, to);
            const first = line.Words[0];
            const last = line.Words[line.Words.length - 1];
            resRegions.push({
                tranContent: dstText,
                boundingBox: `${first.Left},${first.Top},${(last.Left + last.Width) - first.Left},${line.MaxHeight}`
            });
        }

        const renderedBuffer = await renderTextOnImage(req.file.buffer, resRegions);
        
        res.json({ 
            errorCode: 0, 
            render_image: renderedBuffer.toString('base64'), 
            resRegions 
        });

    } catch (err) { 
        res.json({ errorCode: 1, msg: err.message }); 
    }
});

export default app;

// Local test listener
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Translator Running on ${PORT}`));
