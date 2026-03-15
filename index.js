require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const { OpenAI } = require('openai');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const session = require('express-session');
const User = require('./models/user');

const app = express();
const port = process.env.PORT || 3000;

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


// --- Database and Admin User Setup ---
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('MongoDB connected');
    const adminUsername = 'admin';

    // Force-reset the admin user to fix the password issue.
    await User.deleteOne({ username: adminUsername });
    console.log('Attempting to reset admin user...');

    // Re-create the admin user with the plain password.
    // The 'pre-save' hook in the User model will hash it automatically.
    await User.create({
      username: adminUsername,
      email: 'admin@ubuntudigit-talent.com',
      password: 'admin2140', // Plain password
      role: 'admin'
    });
    console.log('Admin user has been reset. The password is now "admin2140".');
  })
  .catch(err => console.error("Erreur de connexion à MongoDB:", err));

// --- Initializations ---
const upload = multer({ dest: 'uploads/' });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Middleware ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'une_cle_secrete_par_defaut',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// --- Helper Functions ---

/**
 * Extracts text from an uploaded file (PDF or TXT).
 * Deletes the file after reading.
 * @param {Object} file - The file object from multer.
 * @returns {Promise<String|null>} The extracted text or null.
 */
const getTextFromFile = async (file) => {
    if (!file) return null;
    const { path: filePath, originalname } = file;
    const extension = path.extname(originalname).toLowerCase();
    let text = '';

    try {
        if (extension === '.pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            text = data.text;
        } else if (extension === '.txt') {
            text = fs.readFileSync(filePath, 'utf-8');
        } else {
            console.warn(`Unsupported file type: ${extension} for file ${originalname}`);
            // Return empty string for unsupported types, but still clean up.
        }
    } catch (readError) {
        console.error(`Error reading file ${originalname}:`, readError);
        throw new Error(`Failed to read content from ${originalname}.`);
    } finally {
        // Always clean up the uploaded file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
    return text;
};


// --- Authorization Middleware ---
const authorizeUser = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

const authorizeApi = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }
    next();
};

const authorizeJobSeeker = (req, res, next) => {
    if (req.session.role !== 'job_seeker') {
        return res.status(403).render('403');
    }
    next();
};

const authorizeRecruiter = (req, res, next) => {
    if (req.session.role !== 'recruiter') {
        return res.status(403).render('403');
    }
    next();
};

const authorizeAdminDashboard = (req, res, next) => {
    if (req.session.adminId && req.session.role === 'admin') {
        return next();
    }
    res.redirect('/admin/login');
};


// --- Routes --- //

app.get('/', (req, res) => res.render('index'));
app.get('/login', (req, res) => res.render('login', {error: req.query.error}));
app.get('/register', (req, res) => res.render('register', {error: req.query.error}));
app.get('/admin/login', (req, res) => res.render('admin-login', {error: req.query.error}));

app.post('/register', async (req, res) => {
  try {
    await User.create(req.body);
    res.redirect('/login');
  } catch (error) {
    res.redirect('/register?error=1');
  }
});

app.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (user && user.role !== 'admin' && await user.comparePassword(password)) {
      req.session.userId = user._id;
      req.session.role = user.role;
      req.session.save((err) => {
        if (err) return next(err);
        if (user.role === 'recruiter') {
          res.redirect('/recruiter');
        } else {
          res.redirect('/analyzer');
        }
      });
    } else {
      res.redirect('/login?error=1');
    }
  } catch (error) {
    next(error);
  }
});

app.post('/admin/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (user && user.role === 'admin' && await user.comparePassword(password)) {
        req.session.adminId = user._id;
        req.session.role = user.role;
        req.session.save((err) => {
            if (err) return next(err);
            res.redirect('/admin');
        });
    } else {
      res.redirect('/admin/login?error=1');
    }
  } catch (error) {
    next(error);
  }
});

app.get('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

// --- Protected Routes ---
app.get('/analyzer', authorizeUser, authorizeJobSeeker, (req, res) => res.render('analyzer'));
app.get('/recruiter', authorizeUser, authorizeRecruiter, (req, res) => res.render('recruiter'));
app.get('/admin', authorizeAdminDashboard, async (req, res) => {
    try {
        const users = await User.find({ role: { $ne: 'admin' } });
        res.render('admin', { users });
    } catch (error) {
        res.status(500).send("Error fetching users");
    }
});

app.post('/admin/update-quota', authorizeAdminDashboard, async (req, res) => {
    try {
        const { userId, newQuota } = req.body;
        if (!userId || !newQuota) {
            return res.status(400).send('User ID and new quota are required.');
        }
        await User.findByIdAndUpdate(userId, { maxAnalyses: parseInt(newQuota, 10) });
        res.redirect('/admin');
    } catch (error) {
        console.error("Error updating quota:", error);
        res.status(500).send("Error updating quota");
    }
});

const analyzeUploads = upload.fields([
    { name: 'cv', maxCount: 1 },
    { name: 'jobDescriptionFile', maxCount: 1 }
]);
app.post('/analyze', authorizeUser, authorizeJobSeeker, analyzeUploads, async (req, res) => {
    let jobDescription;
    const cvFile = req.files.cv ? req.files.cv[0] : null;
    const jobDescriptionFile = req.files.jobDescriptionFile ? req.files.jobDescriptionFile[0] : null;

    try {
        const user = await User.findById(req.session.userId);
        if (user.analysisCount >= user.maxAnalyses) {
            return res.status(403).json({ 
                error: "Vous avez atteint votre quota d'analyses. Pour continuer à utiliser notre service, veuillez nous contacter sur WhatsApp pour mettre à niveau votre compte."
            });
        }

        User.findByIdAndUpdate(req.session.userId, { $inc: { analysisCount: 1 } }).exec();

        if (!cvFile) {
            if (jobDescriptionFile) await getTextFromFile(jobDescriptionFile); // Cleanup
            return res.status(400).json({ error: "Un fichier de CV est requis." });
        }

        if (jobDescriptionFile) {
            jobDescription = await getTextFromFile(jobDescriptionFile);
        } else {
            jobDescription = req.body.jobDescription;
        }

        if (!jobDescription) {
            if (cvFile) await getTextFromFile(cvFile); // Cleanup
            return res.status(400).json({ error: "Une description de l'offre d'emploi est requise (texte ou fichier)." });
        }

        const cvText = await getTextFromFile(cvFile);
        if (!cvText) {
             return res.status(400).json({ error: "Impossible de lire le contenu du CV." });
        }

        const prompt = `
            Analysez le CV fourni par rapport à la description de poste. Votre réponse doit être uniquement un objet JSON valide, sans texte ou explication supplémentaire.
            L'objet JSON doit avoir la structure suivante :
            {
              "score": <Un pourcentage (0-100) représentant la compatibilité du CV avec la description du poste>,
              "analysis": "<Une analyse détaillée du CV. Fournissez des suggestions concrètes d'amélioration, des reformulations et des conseils pour mieux correspondre à l'offre. Utilisez le markdown pour la mise en forme.>",
              "keywords": "<Une liste de mots-clés et de phrases importants manquants dans le CV qui sont cruciaux pour passer les systèmes de suivi des candidats (ATS).>",
              "rewritten_cv": "<Réécrivez complètement le CV pour l'aligner parfaitement avec la description de poste. Votre tâche est de reformuler les descriptions de poste, les compétences et les résumés en utilisant un langage percutant et en intégrant stratégiquement les mots-clés de la description de poste. Basez-vous uniquement sur les informations du CV original et n'inventez aucune information. L'objectif est de produire un CV optimisé pour les ATS, prêt à l'emploi. Le résultat doit être le texte complet et professionnel du CV révisé.>"
            }

            **Description de poste :**
            ${jobDescription}

            **CV :**
            ${cvText}
        `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ "role": "user", "content": prompt }],
            response_format: { type: "json_object" },
            temperature: 0,
        });

        const rawResponse = completion.choices[0].message.content;
        const structuredResponse = JSON.parse(rawResponse);

        res.json(structuredResponse);

    } catch (error) {
        console.error("Error in /analyze:", error);
        res.status(500).json({ error: error.message || "Une erreur est survenue lors de l'analyse du CV." });
    }
});

const recruiterUploads = upload.fields([
    { name: 'cvs' },
    { name: 'jobDescriptionFile', maxCount: 1 }
]);
app.post('/analyze-resumes', authorizeUser, authorizeRecruiter, recruiterUploads, async (req, res) => {
    let jobDescription;
    const cvFiles = req.files.cvs || [];
    const jobDescriptionFile = req.files.jobDescriptionFile ? req.files.jobDescriptionFile[0] : null;

    const allUploadedFiles = [...cvFiles];
    if (jobDescriptionFile) allUploadedFiles.push(jobDescriptionFile);

    try {
        const user = await User.findById(req.session.userId);
        if (user.analysisCount >= user.maxAnalyses) {
            return res.status(403).json({ 
                error: "Vous avez atteint votre quota d'analyses. Pour continuer à utiliser notre service, veuillez nous contacter sur WhatsApp pour mettre à niveau votre compte."
            });
        }

        User.findByIdAndUpdate(req.session.userId, { $inc: { analysisCount: 1 } }).exec();

        if (jobDescriptionFile) {
            jobDescription = await getTextFromFile(jobDescriptionFile);
        } else {
            jobDescription = req.body.jobDescription;
        }

        if (!jobDescription) {
            return res.status(400).json({ error: "La description de l'offre est requise (texte ou fichier)." });
        }
        if (cvFiles.length === 0) {
            return res.status(400).json({ error: "Au moins un CV est requis." });
        }

        const analysisPromises = cvFiles.map(async (file) => {
            try {
                const cvText = await getTextFromFile(file); 
                if (!cvText) {
                    return { filename: file.originalname, score: 0, error: "Impossible de lire le fichier." };
                }

                const prompt = `
                    Analysez le CV suivant par rapport à la description de poste et retournez un score de compatibilité en pourcentage.
                    Votre réponse DOIT être un objet JSON contenant uniquement la clé \"score\". Par exemple: {\"score\": 85}.

                    **Description de poste :**
                    ${jobDescription}

                    **CV :**
                    ${cvText}
                `;

                const completion = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [{ "role": "user", "content": prompt }],
                    response_format: { type: "json_object" },
                    temperature: 0,
                });

                const rawResponse = completion.choices[0].message.content;
                const structuredResponse = JSON.parse(rawResponse);

                return {
                    filename: file.originalname,
                    score: structuredResponse.score,
                };
            } catch (singleFileError) {
                console.error(`Failed to process ${file.originalname}:`, singleFileError);
                return { filename: file.originalname, score: 0, error: singleFileError.message };
            }
        });

        const results = await Promise.all(analysisPromises);
        results.sort((a, b) => b.score - a.score);
        const rankedResults = results.map((result, index) => ({ ...result, rank: index + 1 }));

        res.json(rankedResults);

    } catch (error) {
        console.error("Error in /analyze-resumes:", error);
        for (const file of allUploadedFiles) {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
        }
        res.status(500).json({ error: error.message || "Une erreur est survenue lors de l'analyse des CVs." });
    }
});

app.post('/download-recruiter-results-pdf', authorizeUser, authorizeRecruiter, (req, res) => {
    const { results, jobDescription } = req.body;

    if (!results || !Array.isArray(results)) {
        return res.status(400).send('Données de résultats invalides.');
    }

    try {
        const doc = new PDFDocument({
            size: 'A4',
            margins: { top: 50, bottom: 50, left: 72, right: 72 }
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=resultats-analyse-cv.pdf');

        doc.pipe(res);

        // --- En-tête du document ---
        doc.font('Helvetica-Bold').fontSize(20).text('Rapport d\'analyse des CVs', { align: 'center' });
        doc.moveDown(2);

        // --- Informations sur le poste ---
        doc.font('Helvetica-Bold').fontSize(14).text('Poste Visé');
        doc.font('Helvetica').fontSize(10).text(jobDescription || 'Non spécifiée');
        doc.moveDown(2);

        // --- Tableau des résultats ---
        doc.font('Helvetica-Bold').fontSize(14).text('Classement des Candidats');
        doc.moveDown();

        // En-têtes du tableau
        const tableTop = doc.y;
        const itemX = 72;
        const rankX = itemX;
        const filenameX = rankX + 100;
        const scoreX = filenameX + 250;

        doc.fontSize(10).font('Helvetica-Bold');
        doc.text('Rang', rankX, tableTop);
        doc.text('Nom du Fichier', filenameX, tableTop);
        doc.text('Score', scoreX, tableTop, { width: 100, align: 'right' });
        doc.font('Helvetica');

        // Ligne de séparation
        doc.moveTo(itemX, doc.y + 5).lineTo(520, doc.y + 5).stroke();
        doc.moveDown();

        // Lignes du tableau
        results.forEach((result, index) => {
            const rowY = doc.y;
            doc.fontSize(10);
            doc.text(`#${result.rank}`, rankX, rowY);
            doc.text(result.filename, filenameX, rowY, { width: 230 });
            doc.text(`${result.score}%`, scoreX, rowY, { width: 100, align: 'right' });
            doc.moveDown(1.5);
        });

        doc.end();

    } catch (error) {
        console.error('Erreur lors de la génération du PDF pour le recruteur:', error);
        if (!res.headersSent) {
            res.status(500).send('Erreur lors de la génération du PDF.');
        }
    }
});


app.get('/dev/clear-users', async (req, res) => {
    try {
        await User.deleteMany({});
        res.send('Users collection cleared');
    } catch (error) {
        res.status(500).send('Error clearing users collection');
    }
});


app.post('/download-pdf', (req, res) => {
    const cvContent = req.body.cv_text;

    try {
        const doc = new PDFDocument({
            size: 'A4',
            margins: { top: 50, bottom: 50, left: 72, right: 72 }
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=cv-optimise.pdf');

        doc.pipe(res);

        doc.font('Helvetica').fontSize(10).text(cvContent, {
            align: 'left',
            lineBreak: true
        });

        doc.end();

    } catch (error) {
        console.error('Erreur lors de la génération du PDF avec PDFKit:', error);
        if (!res.headersSent) {
            res.status(500).send('Erreur lors de la génération du PDF.');
        }
    }
});

// API endpoint to get user role
app.get('/api/user-status', authorizeApi, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId).select('analysisCount maxAnalyses');
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        res.json({
            analysisCount: user.analysisCount,
            maxAnalyses: user.maxAnalyses
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching user status.' });
    }
});


app.get('/api/user-role', authorizeApi, (req, res) => {
    if (req.session.role) {
        res.json({ role: req.session.role });
    } else {
        res.status(401).json({ error: 'Not authenticated' });
    }
});

// --- Error Handling ---
app.use((req, res, next) => {
    res.status(404).render('404');
});

app.listen(port, () => {
    console.log(`Le serveur est en écoute sur http://localhost:${port}`);
});
