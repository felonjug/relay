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
    if (fs.existsSync(p)) {
        GlobalFonts.registerFromPath(p, f.name);
        console.log(`✅ Font Loaded: ${f.name}`);
    }
});

// --- 2. LANGUAGE MAPPING ---
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "id": "id", "ru": "ru", "de": "de" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

function toOCRLang(l) {
    // If auto, we use 'eng' as a base but Engine 2 handles other scripts better if we don't restrict it
    const dict = { "zh": "chs", "jp": "jpn", "ko": "kor", "fra": "fre", "spa": "spa", "ara": "ara" };
    let s = String(l).toLowerCase();
    if (s === "auto" || s === "au") return "eng"; // Engine 2 is multi-lang capable
    return dict[s] || "eng";
}

// --- 3. BATCH TRANSLATION (Much faster & more reliable) ---
async function translateBatch(lines, f, t) {
    if (lines.length === 0) return [];
    try {
        const fullText = lines.join('\n');
        let src = (f === "auto" || f === "au") ? "auto" : toGoogleLang(f);
        let tgt = toGoogleLang(t);
        
        const params = new URLSearchParams({ client: 'gtx', sl: src, tl: tgt, dt: 't', q: fullText });
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
            timeout: 15000,
            headers: { "User-Agent": "Mozilla/5.0" }
        });

        if (r.data && r.data[0]) {
            const translatedParagraph = r.data[0].map(s => s[0]).join("");
            // Split back into lines. We use a regex to handle different newline encodings
            return translatedParagraph.split(/\n/);
        }
        return lines;
    } catch (e) { 
        return lines; 
    }
}

// --- 4. IMPROVED OCR (Better Detection) ---
async function extractTextWithOCR(imageBuffer, fromLang) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld'); 
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', toOCRLang(fromLang));
        formData.append('OCREngine', '2'); // Engine 2 is best for UI/Graphics
        formData.append('isOverlayRequired', 'true');
        formData.append('detectOrientation', 'true'); // Catches rotated text
        formData.append('scale', 'true'); // Enhances small text labels

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 60000 
        });

        if (response.data && response.data.OCRExitCode === 1 && response.data.ParsedResults) {
            return response.data.ParsedResults[0].TextOverlay.Lines;
        }
        return [];
    } catch (e) { return []; }
}

// --- 5. RENDERING ENGINE ---
async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text.trim() || w <= 0 || h <= 0) continue;

        const px = ctx.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 1, 1).data;
        ctx.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`;
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2); 

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
            if (measured > w) {
                ctx.font = `${Math.floor(fontSize * (w / measured))}px ${fontChain}`;
            }
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
        // 1. Get all lines from OCR
        const ocrLines = await extractTextWithOCR(req.file.buffer, from);
        if (!ocrLines || ocrLines.length === 0) {
            return res.json({ errorCode: 0, render_image: req.file.buffer.toString('base64'), resRegions: [] });
        }

        // 2. Prepare for batch translation
        const sourceTexts = ocrLines.map(line => line.LineText);
        const translatedTexts = await translateBatch(sourceTexts, from, to);

        // 3. Map translations back to regions
        const resRegions = [];
        ocrLines.forEach((line, index) => {
            const first = line.Words[0];
            const last = line.Words[line.Words.length - 1];
            if (!first || !last) return;

            resRegions.push({
                tranContent: translatedTexts[index] || line.LineText,
                boundingBox: `${first.Left},${first.Top},${(last.Left + last.Width) - first.Left},${line.MaxHeight}`
            });
        });

        // 4. Render and Respond
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine optimized for max detection on ${PORT}`));
