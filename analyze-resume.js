// api/analyze-resume.js
// دالة خلفية (Vercel Serverless Function) لتحليل السيرة الذاتية.
// تُشغَّل على Node.js فقط — لا يصل هذا الكود إلى المتصفح، ولذلك يُخزَّن مفتاح الذكاء
// الاصطناعي بأمان في متغير بيئة على الخادم ولا يظهر أبدًا في HTML أو JavaScript الأمامي.
//
// متغير البيئة المطلوب (يُضبط من لوحة تحكم الاستضافة، وليس داخل الكود):
//   ANTHROPIC_API_KEY

const formidable = require('formidable');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// نوقف محلل الجسم الافتراضي لأننا نستقبل ملفًا (multipart/form-data)
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 ميجابايت
const ALLOWED_EXTENSIONS = ['pdf', 'docx'];
const AI_MODEL = 'claude-sonnet-5'; // يمكن استبداله بأي نموذج متاح في حسابك

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'الطريقة غير مسموحة.' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'الخدمة غير مهيأة حاليًا. الرجاء المحاولة لاحقًا.' });
    return;
  }

  let uploadedFilePath = null;

  try {
    const { file, error: parseError } = await parseUpload(req);

    if (parseError) {
      res.status(400).json({ error: parseError });
      return;
    }

    uploadedFilePath = file.filepath;
    const extension = getExtension(file.originalFilename || '');

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      res.status(400).json({ error: 'صيغة الملف غير مدعومة. الرجاء رفع ملف PDF أو DOCX فقط.' });
      return;
    }

    // استخراج النص من الملف
    let extractedText = '';
    try {
      if (extension === 'pdf') {
        const buffer = fs.readFileSync(file.filepath);
        const parsed = await pdfParse(buffer);
        extractedText = parsed.text || '';
      } else if (extension === 'docx') {
        const result = await mammoth.extractRawText({ path: file.filepath });
        extractedText = result.value || '';
      }
    } catch (extractionErr) {
      res.status(422).json({
        error: 'تعذّرت قراءة الملف. قد يكون تالفًا أو محميًا بكلمة مرور. الرجاء رفع نسخة أخرى.',
      });
      return;
    }

    extractedText = extractedText.trim();

    if (extractedText.length < 50) {
      res.status(422).json({
        error: 'لم نتمكن من العثور على محتوى كافٍ داخل الملف. تأكد أنه سيرة ذاتية نصية وليست صورة ممسوحة ضوئيًا.',
      });
      return;
    }

    // حدّ أقصى لطول النص المُرسل للنموذج تجنبًا لتضخم التكلفة
    const trimmedText = extractedText.slice(0, 12000);

    const analysis = await analyzeWithAI(trimmedText);

    res.status(200).json(analysis);
  } catch (err) {
    console.error('analyze-resume error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء تحليل السيرة الذاتية. الرجاء المحاولة مرة أخرى.' });
  } finally {
    // حذف الملف المؤقت من الخادم فور الانتهاء — لا يُحتفظ بأي نسخة من السيرة
    if (uploadedFilePath) {
      fs.unlink(uploadedFilePath, function () {});
    }
  }
};

function getExtension(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function parseUpload(req) {
  return new Promise(function (resolve) {
    const form = formidable({
      maxFileSize: MAX_SIZE_BYTES,
      multiples: false,
    });

    form.parse(req, function (err, fields, files) {
      if (err) {
        if (err.code === 1009 || /maxFileSize/i.test(err.message || '')) {
          resolve({ error: 'حجم الملف يتجاوز 10 ميجابايت. الرجاء رفع ملف أصغر.' });
          return;
        }
        resolve({ error: 'تعذّر استلام الملف. حاول مرة أخرى.' });
        return;
      }

      const uploaded = files.resume;
      const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;

      if (!file) {
        resolve({ error: 'لم يتم إرفاق أي ملف.' });
        return;
      }

      if (!file.size || file.size === 0) {
        resolve({ error: 'الملف فارغ. الرجاء التأكد من الملف والمحاولة مرة أخرى.' });
        return;
      }

      // فحص نوع الملف الحقيقي (MIME) كطبقة حماية إضافية بجانب الامتداد
      const mimetype = file.mimetype || '';
      const allowedMimes = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ];
      if (mimetype && allowedMimes.indexOf(mimetype) === -1) {
        resolve({ error: 'صيغة الملف غير مدعومة. الرجاء رفع ملف PDF أو DOCX فقط.' });
        return;
      }

      resolve({ file: file });
    });
  });
}

async function analyzeWithAI(resumeText) {
  const systemPrompt =
    'أنت خبير موارد بشرية متخصص في تحليل السير الذاتية لسوق العمل السعودي ومتوافق مع أنظمة ATS. ' +
    'مهمتك تحليل نص السيرة الذاتية المُرسل إليك فقط، بصدق وبدون مجاملة، واستنادًا إلى محتواه الفعلي حصرًا. ' +
    'يجب أن يكون ردك عبارة عن JSON صالح فقط، بدون أي نص إضافي قبله أو بعده، وبدون علامات ```. ' +
    'التزم تمامًا بالمخطط التالي:\n' +
    '{\n' +
    '  "overallScore": رقم من 0 إلى 100,\n' +
    '  "breakdown": {\n' +
    '    "atsCompatibility": رقم من 0 إلى 100,\n' +
    '    "clarity": رقم من 0 إلى 100,\n' +
    '    "summaryStrength": رقم من 0 إلى 100,\n' +
    '    "achievementsDescription": رقم من 0 إلى 100,\n' +
    '    "keywords": رقم من 0 إلى 100,\n' +
    '    "sectionOrder": رقم من 0 إلى 100,\n' +
    '    "languageErrors": رقم من 0 إلى 100,\n' +
    '    "lengthReadability": رقم من 0 إلى 100,\n' +
    '    "contactInfoClarity": رقم من 0 إلى 100\n' +
    '  },\n' +
    '  "strengths": ["نقطة قوة 1", "نقطة قوة 2", "..."],\n' +
    '  "weaknesses": ["نقطة تحتاج تحسين 1", "نقطة تحتاج تحسين 2", "..."],\n' +
    '  "topImprovements": ["أهم تحسين 1", "أهم تحسين 2", "أهم تحسين 3"]\n' +
    '}\n' +
    'اجعل كل الملاحظات مبنية فعليًا على محتوى السيرة المرسلة، ولا تكرر عبارات عامة ثابتة. ' +
    'اكتب جميع النصوص باللغة العربية الفصحى الواضحة، وبأسلوب مهني غير جارح.';

  const userPrompt = 'حلّل السيرة الذاتية التالية وأعد النتيجة وفق المخطط المطلوب:\n\n' + resumeText;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    throw new Error('AI request failed with status ' + response.status);
  }

  const data = await response.json();
  const rawText = (data.content && data.content[0] && data.content[0].text) || '';
  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Failed to parse AI JSON response');
  }

  return parsed;
}
