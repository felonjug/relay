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

// --- 1. FONT REGISTRATION ---
const fontsDir = path.resolve(process.cwd(), "fonts");
const fontFiles = [
    { file: "NotoSansArabic-Regular.ttf", name: "NotoArabic" },
    { file: "NotoSansCJKsc-Regular.otf", name: "NotoSansCJK" },
    { file: "NotoSans-Regular.ttf", name: "NotoSans" }
];
fontFiles.forEach(f => {
    const p = path.join(fontsDir, f.file);
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, f.name);
});

// --- 2. MULTI-LANGUAGE OCR MAPPING ---
function toOCRLang(l) {
    const dict = { "zh": "chs", "jp": "jpn", "ko": "kor", "ara": "ara", "fra": "fre", "spa": "spa" };
    let s = String(l).toLowerCase();
    if (s === "auto" || s === "au") {
        // Look for all major scripts at once
        return "eng,ara,chs,jpn,kor,fre,ger,ita,spa"; 
    }
    return dict[s] || "eng";
}

// --- 3. BATCH TRANSLATION ---
async function translateBatch(lines, f, t) {
    if (lines.length === 0) return [];
    try {
        const fullText = lines.join('\n');
        const params = new URLSearchParams({ 
            client: 'gtx', 
            sl: 'auto', // Google is best at per-line auto-detection
            tl: (t === "jp") ? "ja" : (t === "zh") ? "zh-CN" : t, 
            dt: 't', 
            q: fullText 
        });
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
            timeout: 15000,
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (r.data && r.data[0]) {
            const translatedParagraph = r.data[0].map(s => s[0]).join("");
            return translatedParagraph.split('\n');
        }
        return lines;
    } catch (e) { return lines; }
}

// --- 4. THE OCR ENGINE (Multi-Script Enabled) ---
async function extractTextWithOCR(imageBuffer, fromLang) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld'); 
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', toOCRLang(fromLang));
        formData.append('OCREngine', '2'); 
        formData.append('isOverlayRequired', 'true');
        formData.append('scale', 'true'); 
        formData.append('detectOrientation', 'true');

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 60000 
        });

        return response.data?.ParsedResults?.[0]?.TextOverlay?.Lines || [];
    } catch (e) { return []; }
}

// --- 5. SMART RENDERING ENGINE ---
async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text.trim() || w <= 0 || h <= 0) continue;

        // Masking
        const px = ctx.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 1, 1).data;
        ctx.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`;
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2); 

        // Style
        const brightness = (px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114);
        ctx.fillStyle = brightness > 125 ? 'black' : 'white';
        
        let fontSize = Math.floor(h * 0.82); 
        const isArabic = /[\u0600-\u06FF]/.test(text);
        const fontChain = '"NotoArabic", "NotoSansCJK", "NotoSans", sans-serif';
        
        ctx.font = `${fontSize}px ${fontChain}`;
        ctx.textBaseline = 'middle';

        if (isArabic) {
            ctx.direction = 'rtl'; 
            ctx.textAlign = 'right';
            let measured = ctx.measureText(text).width;
            if (measured > w) ctx.font = `${Math.floor(fontSize * (w / measured))}px ${fontChain}`;
            ctx.fillText(text, x + w, y + (h / 2)); 
        } else {
            ctx.direction = 'ltr';
            ctx.textAlign = 'left';
            ctx.fillText(text, x, y + (h / 2), w); 
        }
    }
    return canvas.toBuffer('image/jpeg');
}

// --- 6. API ENDPOINT ---
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });
    const { from = "auto", to = "zh" } = req.body;

    try {
        const ocrLines = await extractTextWithOCR(req.file.buffer, from);
        if (!ocrLines.length) return res.json({ errorCode: 0, render_image: req.file.buffer.toString('base64'), resRegions: [] });

        const sourceTexts = ocrLines.map(l => l.LineText);
        const translatedTexts = await translateBatch(sourceTexts, from, to);

        const resRegions = [];
        ocrLines.forEach((line, i) => {
            const first = line.Words[0], last = line.Words[line.Words.length - 1];
            resRegions.push({
                tranContent: translatedTexts[i] || line.LineText,
                boundingBox: `${first.Left},${first.Top},${(last.Left + last.Width) - first.Left},${line.MaxHeight}`
            });
        });

        const rendered = await renderTextOnImage(req.file.buffer, resRegions);
        res.json({ errorCode: 0, render_image: rendered.toString('base64'), resRegions });
    } catch (err) { res.json({ errorCode: 1, msg: err.message }); }
});

export default app;
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Multi-Script Engine Active on ${PORT}`));
