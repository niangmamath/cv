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
const Plan = require('./models/plan');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('MongoDB connected');
    await seedAdminUser();
    await syncPlans(); 
    await syncUserLimits(); // Add this final sync step
  })
  .catch(err => console.error("Erreur de connexion à MongoDB:", err));

async function seedAdminUser() {
    try {
        const adminExists = await User.findOne({ username: 'admin' });
        if (!adminExists) {
            await User.create({ username: 'admin', email: 'admin@ubuntudigit-talent.com', password: 'admin2140', role: 'admin' });
            console.log('Admin user created.');
        }
    } catch (error) {
        console.error('Error seeding admin user:', error);
    }
}

async function syncPlans() {
    try {
        console.log('Synchronizing plans with the database...');
        const plansToSync = [
            { name: 'Gratuit Candidat', userType: 'job_seeker', price: '0 MAD', priceDesc: 'pour commencer', analysisLimit: 3, features: ['3 analyses de CV', 'Analyse de compatibilité', 'Suggestions de mots-clés', 'Support par email'], ctaText: 'Commencer gratuitement', ctaLink: '/register', displayOrder: 1 },
            { name: 'Premium', userType: 'job_seeker', price: '99 MAD', priceDesc: '/ mois', analysisLimit: 15, features: ['15 analyses de CV', 'Réécriture de CV par IA', 'Tons personnalisables (Pro, Créatif...)', 'Support prioritaire'], badge: 'Populaire', ctaText: 'Passer au Premium', ctaLink: '#', isCtaOutline: false, displayOrder: 2 },
            { name: 'Gratuit Recruteur', userType: 'recruiter', price: '0 MAD', priceDesc: 'pour les besoins simples', analysisLimit: 2, features: ['2 analyses de CV', 'Analyse multi-CV', 'Classement des candidats', 'Support par email'], ctaText: 'Créer un compte', ctaLink: '/register', displayOrder: 1 },
            { name: 'Pro', userType: 'recruiter', price: '499 MAD', priceDesc: '/ mois', analysisLimit: 25, features: ['25 analyses de CV', 'Téléchargement des rapports PDF', 'Pas de publicité', 'Support téléphonique et email'], badge: 'Meilleure Valeur', ctaText: 'Choisir Pro', ctaLink: '#', displayOrder: 2 },
            { name: 'Entreprise', userType: 'recruiter', price: 'Sur devis', priceDesc: '', analysisLimit: 50, features: ['50 analyses de CV', 'Intégration ATS', 'Support dédié', 'Tableau de bord personnalisé'], ctaText: 'Nous contacter', ctaLink: 'https://wa.me/212783346308', isCtaOutline: true, displayOrder: 3 },
        ];

        for (const planData of plansToSync) {
            await Plan.updateOne({ name: planData.name }, { $set: planData }, { upsert: true });
        }
        
        console.log('Plan synchronization complete.');

    } catch (error) {
        console.error('Error during plan synchronization process:', error);
    }
}

async function syncUserLimits() {
    try {
        console.log('Syncing user analysis limits with their plans...');
        const plans = await Plan.find({});
        let updates = [];

        for (const plan of plans) {
            updates.push({
                updateMany: {
                    filter: { plan: plan._id, maxAnalyses: { $ne: plan.analysisLimit } },
                    update: { $set: { maxAnalyses: plan.analysisLimit } }
                }
            });
        }

        if (updates.length > 0) {
            const result = await User.bulkWrite(updates);
            if (result.isOk()) console.log(`User limits synchronized. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
        } else {
            console.log('No user limits needed synchronization.');
        }

    } catch (error) {
        console.error('Error during user limit synchronization:', error);
    }
}


const upload = multer({ dest: 'uploads/' });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'default_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

app.use(async (req, res, next) => {
    res.locals.user = req.session.userId ? await User.findById(req.session.userId).populate('plan') : null;
    next();
});

const getTextFromFile = async (file) => {
    if (!file) return null;
    const { path: filePath, originalname } = file;
    const extension = path.extname(originalname).toLowerCase();
    let text = '';
    try {
        if (extension === '.pdf') {
            text = (await pdf(fs.readFileSync(filePath))).text;
        } else if (extension === '.txt') {
            text = fs.readFileSync(filePath, 'utf-8');
        }
    } catch (readError) {
        console.error(`Error reading file ${originalname}:`, readError);
    } finally {
        if (fs.existsSync(filePath)) {
             fs.unlinkSync(filePath);
        }
    }
    return text;
};

const authorizeUser = (req, res, next) => req.session.userId ? next() : res.redirect('/login');
const authorizeApi = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Authentication required.' });
const authorizeJobSeeker = (req, res, next) => (res.locals.user && res.locals.user.role === 'job_seeker') ? next() : res.status(403).render('403');
const authorizeRecruiter = (req, res, next) => (res.locals.user && res.locals.user.role === 'recruiter') ? next() : res.status(403).render('403');
const authorizeAdminDashboard = (req, res, next) => (req.session.adminId && req.session.role === 'admin') ? next() : res.redirect('/admin/login');

app.get('/', (req, res) => res.render('index'));
app.get('/login', (req, res) => res.render('login', { error: req.query.error }));
app.get('/register', (req, res) => res.render('register', { error: req.query.error }));
app.get('/admin/login', (req, res) => res.render('admin-login', { error: req.query.error }));

app.get('/pricing', async (req, res) => {
    try {
        let jobSeekerPlans = [];
        let recruiterPlans = [];

        if (res.locals.user) {
            // User is logged in, show plans for their role
            if (res.locals.user.role === 'job_seeker') {
                jobSeekerPlans = await Plan.find({ userType: 'job_seeker' }).sort({ displayOrder: 1 });
            } else if (res.locals.user.role === 'recruiter') {
                recruiterPlans = await Plan.find({ userType: 'recruiter' }).sort({ displayOrder: 1 });
            }
        } else {
            // User is not logged in, show all plans
            jobSeekerPlans = await Plan.find({ userType: 'job_seeker' }).sort({ displayOrder: 1 });
            recruiterPlans = await Plan.find({ userType: 'recruiter' }).sort({ displayOrder: 1 });
        }

        res.render('pricing', { jobSeekerPlans, recruiterPlans });

    } catch (error) {
        console.error('Error fetching plans:', error);
        res.status(500).send('Error loading pricing page.');
    }
});

app.post('/register', async (req, res) => {
  try {
    const planName = req.body.role === 'recruiter' ? 'Gratuit Recruteur' : 'Gratuit Candidat';
    const defaultPlan = await Plan.findOne({ name: planName });
    const newUser = {
        ...req.body,
        plan: defaultPlan ? defaultPlan._id : null,
        maxAnalyses: defaultPlan ? defaultPlan.analysisLimit : 0
    };
    await User.create(newUser);
    res.redirect('/login');
  } catch (error) {
    console.error("Register Error:", error);
    res.redirect('/register?error=1');
  }
});

app.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (user && user.role !== 'admin' && await user.comparePassword(password)) {
      req.session.userId = user._id;
      res.redirect(user.role === 'recruiter' ? '/recruiter' : '/analyzer');
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
        req.session.role = 'admin';
        res.redirect('/admin');
    } else {
      res.redirect('/admin/login?error=1');
    }
  } catch (error) {
    next(error);
  }
});

app.get('/logout', (req, res, next) => {
  req.session.destroy((err) => err ? next(err) : res.redirect('/'));
});

app.get('/analyzer', authorizeUser, authorizeJobSeeker, (req, res) => res.render('analyzer'));
app.get('/recruiter', authorizeUser, authorizeRecruiter, (req, res) => res.render('recruiter'));

app.get('/admin', authorizeAdminDashboard, async (req, res) => {
    try {
        const users = await User.find({ role: { $ne: 'admin' } }).populate('plan');
        const plans = await Plan.find({});
        res.render('admin', { users, plans });
    } catch (error) {
        console.error("Admin Panel Error:", error);
        res.status(500).send("Error fetching data for admin panel");
    }
});

app.post('/admin/update-plan', authorizeAdminDashboard, async (req, res) => {
    try {
        const { userId, planId } = req.body;
        const plan = await Plan.findById(planId);
        if (!plan) {
            return res.status(404).send("Plan not found");
        }
        await User.findByIdAndUpdate(userId, { 
            plan: planId, 
            maxAnalyses: plan.analysisLimit 
        });
        res.redirect('/admin');
    } catch (error) {
        console.error("Update Plan Error:", error);
        res.status(500).send("Error updating user plan");
    }
});

app.post('/admin/delete-user', authorizeAdminDashboard, async (req, res) => {
    try {
        await User.findByIdAndDelete(req.body.userId);
        res.redirect('/admin');
    } catch (error) {
        res.status(500).send("Error deleting user");
    }
});

const analyzeUploads = upload.fields([ { name: 'cv', maxCount: 1 }, { name: 'jobDescriptionFile', maxCount: 1 } ]);

app.post('/analyze', authorizeUser, authorizeJobSeeker, analyzeUploads, async (req, res) => {
    const { cv: cvFile, jobDescriptionFile } = req.files || {};
    try {
        const user = await User.findById(req.session.userId); // Re-fetch user to be sure
        if (user.analysisCount >= user.maxAnalyses) {
            return res.status(403).json({ error: "Quota d'analyse atteint." });
        }

        const cvText = await getTextFromFile(cvFile ? cvFile[0] : null);
        const jobDescription = req.body.jobDescription || await getTextFromFile(jobDescriptionFile ? jobDescriptionFile[0] : null);

        if (!cvText || !jobDescription) {
            return res.status(400).json({ error: "CV et description de l'offre requis." });
        }

        const prompt = `Analysez le CV fourni par rapport à la description de poste. Votre réponse doit être uniquement un objet JSON valide avec les clés : "score" (nombre de 0 à 100), "analysis" (markdown string), "keywords" (string), et "rewritten_cv" (string). CV: ${cvText} Description: ${jobDescription}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ "role": "user", "content": prompt }],
            response_format: { type: "json_object" },
            temperature: 0.2,
        });

        let analysisData;
        try {
            analysisData = JSON.parse(completion.choices[0].message.content);
        } catch (parseError) {
            console.error("Failed to parse JSON from OpenAI:", completion.choices[0].message.content);
            throw new Error("L'analyse a échoué car la réponse de l'IA était mal formatée.");
        }

        if (!analysisData || typeof data.score === 'undefined' || !analysisData.analysis) {
            console.error("Invalid or incomplete data from OpenAI:", analysisData);
            throw new Error("L'analyse a retourné des données incomplètes.");
        }
        
        await User.findByIdAndUpdate(req.session.userId, { $inc: { analysisCount: 1 } });
        res.json(analysisData);

    } catch (error) {
        console.error("Error in /analyze route:", error);
        res.status(500).json({ error: error.message });
    }
});

const recruiterUploads = upload.fields([ { name: 'cvs' }, { name: 'jobDescriptionFile', maxCount: 1 } ]);

app.post('/analyze-resumes', authorizeUser, authorizeRecruiter, recruiterUploads, async (req, res) => {
    const { cvs, jobDescriptionFile } = req.files || {};
    
    try {
        const user = await User.findById(req.session.userId); // Re-fetch user
        const remainingAnalyses = user.maxAnalyses - user.analysisCount;

        if (!cvs || cvs.length === 0) {
            return res.status(400).json({ error: "Veuillez téléverser au moins un CV." });
        }

        if (cvs.length > remainingAnalyses) {
            return res.status(403).json({ error: `Quota insuffisant. Vous avez ${remainingAnalyses} analyses restantes, mais vous essayez d'en utiliser ${cvs.length}.` });
        }

        const jobDescription = req.body.jobDescription || await getTextFromFile(jobDescriptionFile ? jobDescriptionFile[0] : null);
        if (!jobDescription) {
            return res.status(400).json({ error: "La description de l'offre d'emploi est requise." });
        }

        const analysisPromises = cvs.map(async (cvFile) => {
            const cvText = await getTextFromFile(cvFile);
            if (!cvText) {
                return { filename: cvFile.originalname, error: "Impossible de lire le fichier." };
            }

            try {
                const prompt = `Évalue ce CV en fonction de la description de poste. Fournis un objet JSON avec les clés "score" (nombre), "strengths" (chaîne), et "weaknesses" (chaîne). CV: ${cvText} Description: ${jobDescription}`;
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [{ "role": "user", "content": prompt }],
                    response_format: { type: "json_object" },
                    temperature: 0.1,
                });

                const result = JSON.parse(completion.choices[0].message.content);
                return { filename: cvFile.originalname, ...result };

            } catch (e) {
                return { filename: cvFile.originalname, error: `L'analyse a échoué: ${e.message}` };
            }
        });

        const results = await Promise.all(analysisPromises);

        const successfulAnalyses = results.filter(r => !r.error);
        await User.findByIdAndUpdate(req.session.userId, { $inc: { analysisCount: successfulAnalyses.length } });

        results.sort((a, b) => (b.score || 0) - (a.score || 0));
        const rankedResults = results.map((result, index) => ({ ...result, rank: index + 1 }));

        res.json(rankedResults);

    } catch (error) {
        console.error("Error in /analyze-resumes route:", error);
        res.status(500).json({ error: error.message });
    }
});


app.post('/download-recruiter-results-pdf', authorizeUser, authorizeRecruiter, (req, res) => {
     try {
        const { results, jobDescription } = req.body;

        if (!results || !Array.isArray(results) || results.length === 0) {
            return res.status(400).send('Données de résultats invalides ou manquantes.');
        }

        const doc = new PDFDocument({ margins: { top: 50, bottom: 50, left: 72, right: 72 } });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=resultats-analyse.pdf');

        doc.pipe(res);

        doc.fontSize(20).font('Helvetica-Bold').text('Rapport d\'Analyse de CVs', { align: 'center' }).moveDown();

        doc.fontSize(14).font('Helvetica-Bold').text('Description du Poste').moveDown(0.5);
        doc.font('Helvetica').fontSize(10).text(jobDescription || 'Non fournie').moveDown();

        results.forEach(result => {
            doc.addPage();
            doc.fontSize(16).font('Helvetica-Bold').text(`Candidat: ${result.filename}`);
            doc.fontSize(12).font('Helvetica-Bold').text(`Rang: #${result.rank} | Score de compatibilité: ${result.score}%`).moveDown();

            doc.fontSize(12).font('Helvetica-Bold').fillColor('green').text('Points Forts').moveDown(0.5);
            doc.font('Helvetica').fontSize(10).fillColor('black').text(result.strengths || 'Aucun détecté.').moveDown();

            doc.fontSize(12).font('Helvetica-Bold').fillColor('red').text('Points Faibles').moveDown(0.5);
            doc.font('Helvetica').fontSize(10).fillColor('black').text(result.weaknesses || 'Aucun détecté.').moveDown();
            
            if(result.error){
                 doc.fontSize(12).font('Helvetica-Bold').fillColor('orange').text('Erreur').moveDown(0.5);
                 doc.font('Helvetica').fontSize(10).fillColor('black').text(result.error).moveDown();
            }
        });

        doc.end();

    } catch (error) {
        console.error('Erreur lors de la génération du PDF pour le recruteur:', error);
        res.status(500).send('Erreur lors de la génération du fichier PDF.');
    }
});

app.post('/download-pdf', (req, res) => {
    try {
        const { cv_text } = req.body;

        if (!cv_text) {
            return res.status(400).send('Aucun texte de CV fourni.');
        }

        const doc = new PDFDocument({
            margins: { top: 72, bottom: 72, left: 72, right: 72 }
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=cv-optimise.pdf');

        doc.pipe(res);
        doc.font('Helvetica').fontSize(12).text(cv_text, { align: 'justify' });
        doc.end();

    } catch (error) {
        console.error('Erreur lors de la génération du PDF:', error);
        res.status(500).send('Erreur lors de la génération du fichier PDF.');
    }
});

app.get('/api/user-status', authorizeApi, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId).select('analysisCount maxAnalyses');
        res.json({ analysisCount: user.analysisCount, maxAnalyses: user.maxAnalyses });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching user status.' });
    }
});

app.get('/api/user-role', authorizeApi, (req, res) => {
    res.json({ role: res.locals.user ? res.locals.user.role : null });
});

app.use((req, res, next) => res.status(404).render('404'));

app.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
