require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const { OpenAI } = require('openai');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const path = require('path'); // Importer le module path

const app = express();
const port = process.env.PORT || 3000;

const upload = multer({ dest: 'uploads/' });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // Servir les fichiers statiques depuis 'public'

// Route pour la page d'accueil
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Route pour la page de l'analyseur
app.get('/analyzer', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'analyzer.html'));
});

app.post('/analyze', upload.single('cv'), async (req, res) => {
    try {
        const jobDescription = req.body.jobDescription;
        const cvPath = req.file.path;

        const dataBuffer = fs.readFileSync(cvPath);
        const data = await pdf(dataBuffer);
        const cvText = data.text;

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

        fs.unlinkSync(cvPath);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Une erreur est survenue lors de l'analyse du CV." });
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

app.listen(port, () => {
    console.log(`Le serveur est en écoute sur http://localhost:${port}`);
});
