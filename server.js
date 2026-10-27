require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Variables d'environnement
const HOST = process.env.INTRA_API_HOST;
const API_KEY = process.env.INTRA_API_KEY;
const API_SECRET = process.env.INTRA_API_SECRET;

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ==========================================
// FONCTION DE SÉCURITÉ : GÉNÉRATION DU TOKEN
// ==========================================
function generateAuthToken(method, apiPath, params, rawBody) {
    const sortedKeys = Object.keys(params).sort();
    let signatureComponents = sortedKeys.map(k => `${k}=${params[k]}&`);

    if (rawBody) {
        signatureComponents.push(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
    }

    signatureComponents.push(method.toUpperCase());
    signatureComponents.push(apiPath);
    signatureComponents.push(API_SECRET);

    const stringBeforeHash = signatureComponents.join('');
    const signature = crypto.createHash('sha1').update(stringBeforeHash).digest('hex').toLowerCase();
    const token = Buffer.from(`${API_KEY}:${signature}`).toString('base64');

    return token;
}

// ==========================================
// ROUTES DE L'APPLICATION
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/generate', async (req, res) => {
    const studentId = req.body.student_id;

    try {
        console.log(`\n--- Début du traitement pour l'étudiant ${studentId} ---`);
        
        // ==========================================
        // 1. RÉCUPÉRATION DU PROFIL DE L'ÉTUDIANT
        // ==========================================
        console.log(`Récupération du profil de l'étudiant...`);
        const profilePath = `/api/v1/students/${studentId}`;
        const profileTimestamp = Math.floor(Date.now() / 1000);
        const profileParams = { timestamp: profileTimestamp };
        const profileToken = generateAuthToken('GET', profilePath, profileParams, null);
        
        const profileResponse = await fetch(`https://${HOST}${profilePath}?timestamp=${profileTimestamp}`, {
            method: 'GET',
            headers: {
                'X-AUTH-TOKEN': profileToken,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'cfclearance': 'true'
            }
        });

        if (!profileResponse.ok) {
            const errorText = await profileResponse.text();
            throw new Error(`Impossible de trouver l'étudiant (${profileResponse.status}): ${errorText}`);
        }

        const studentProfile = await profileResponse.json();
        const fullName = `${studentProfile.first_name || ''} ${studentProfile.last_name || ''}`.trim() || studentProfile.email || "Nom inconnu";
        console.log(`Étudiant trouvé : ${fullName}`);

        // ==========================================
        // 2. RÉCUPÉRATION DES PROJETS (NOTES)
        // ==========================================
        console.log(`Récupération des notes...`);
        const projectsPath = `/api/v1/students/${studentId}/projects`;
        let allProjects = [];
        let nextCursor = null;

        do {
            const timestamp = Math.floor(Date.now() / 1000);
            const params = { timestamp: timestamp, statuses: 'all' };
            if (nextCursor) params.cursor = nextCursor;

            const token = generateAuthToken('GET', projectsPath, params, null);
            const queryParams = new URLSearchParams(params).toString();
            const url = `https://${HOST}${projectsPath}?${queryParams}`;

            const apiResponse = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-AUTH-TOKEN': token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'cfclearance': 'true'
                }
            });

            if (!apiResponse.ok) {
                const errorText = await apiResponse.text();
                throw new Error(`Erreur API Projets (${apiResponse.status}): ${errorText}`);
            }

            const data = await apiResponse.json();
            if (data.items) allProjects = allProjects.concat(data.items);
            nextCursor = data.next; 

        } while (nextCursor);

        console.log(`${allProjects.length} projets bruts trouvés.`);

        // ==========================================
        // 3. FILTRAGE ET SUPPRESSION DES DOUBLONS
        // ==========================================
        const uniqueProjectsMap = new Map();

        allProjects.forEach(p => {
            if (p.completion === null || p.completion === undefined) return;
            
            const status = (p.status || '').toLowerCase();
            if (status.includes('not validated') || status.includes('not_validated')) return;

            const currName = (p.curriculum && p.curriculum.name) ? p.curriculum.name : 'Autres projets';
            if (currName.toLowerCase().includes('not validated')) return;

            const uniqueKey = `${currName}-${p.name}`;

            if (!uniqueProjectsMap.has(uniqueKey)) {
                uniqueProjectsMap.set(uniqueKey, p);
            } else {
                const existingProject = uniqueProjectsMap.get(uniqueKey);
                const currentScore = p.completion || 0;
                const existingScore = existingProject.completion || 0;
                
                if (currentScore > existingScore) {
                    uniqueProjectsMap.set(uniqueKey, p);
                }
            }
        });

        // ==========================================
        // 4. TRI CHRONOLOGIQUE ET REGROUPEMENT
        // ==========================================
        const filteredProjects = Array.from(uniqueProjectsMap.values());

        // Tri des PROJETS par activité (plus ancien au plus récent)
        filteredProjects.sort((a, b) => {
            let timeA = (a.updated_at || a.created_at) ? new Date(a.updated_at || a.created_at).getTime() : 0;
            let timeB = (b.updated_at || b.created_at) ? new Date(b.updated_at || b.created_at).getTime() : 0;
            
            // Si on a les deux dates, on trie normalement
            if (timeA > 0 && timeB > 0) return timeA - timeB;
            // Si une date manque, on pousse le projet à la fin
            if (timeA === 0 && timeB > 0) return 1; 
            if (timeB === 0 && timeA > 0) return -1;
            // Si aucune date, on trie par ID
            return a.id - b.id; 
        });

        // Regroupement par cursus (l'objet Map conserve l'ordre naturel d'insertion !)
        const curriculumsMap = new Map();
        
        filteredProjects.forEach(p => {
            const curriculumName = (p.curriculum && p.curriculum.name) ? p.curriculum.name : 'Autres projets';
            
            if (!curriculumsMap.has(curriculumName)) {
                curriculumsMap.set(curriculumName, {
                    name: curriculumName,
                    projects: []
                });
            }
            curriculumsMap.get(curriculumName).projects.push(p);
        });

        // On convertit le Map en Array final
        const sortedCurriculums = Array.from(curriculumsMap.values());

        // ==========================================
        // 5. GÉNÉRATION DU PDF
        // ==========================================
        console.log(`Création du PDF pour ${fullName} (${filteredProjects.length} projets finaux)...`);
        const htmlContent = generateHTML(sortedCurriculums, studentId, fullName);

        const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ 
            format: 'A4', 
            printBackground: true,
            margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
        });

        await browser.close();

        const safeFileName = fullName.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=releve_notes_${safeFileName}.pdf`);
        res.send(pdfBuffer);
        
        console.log(`✅ Succès ! PDF généré pour ${fullName}.`);

    } catch (error) {
        console.error("❌", error);
        res.status(500).send(`<h2>Une erreur est survenue</h2><p>${error.message}</p><br><a href="/">Retour</a>`);
    }
});

// ==========================================
// MODÈLE HTML DU PDF
// ==========================================
function generateHTML(sortedCurriculums, studentId, fullName) {
    const dateStr = new Date().toLocaleDateString('fr-FR');
    let contentHtml = '';

    // LECTURE DU LOGO LOCAL EN BASE64
    let logoBase64 = '';
    try {
        const logoPath = path.join(__dirname, 'public', 'logo.png');
        if (fs.existsSync(logoPath)) {
            const ext = path.extname(logoPath).replace('.', '');
            const logoData = fs.readFileSync(logoPath);
            logoBase64 = `data:image/${ext};base64,${logoData.toString('base64')}`;
        }
    } catch (err) {
        console.log("⚠️ Logo local non trouvé ou impossible à lire.");
    }

    const logoHtml = logoBase64 
        ? `<img src="${logoBase64}" alt="Logo" style="max-width: 250px; margin-bottom: 15px;">` 
        : `<h1>Relevé de notes officiel</h1>`;

    // Génération des tableaux par cursus
    sortedCurriculums.forEach(curriculum => {
        let tableRows = '';
        let totalScore = 0;
        let projectCount = 0;
        
        curriculum.projects.forEach(p => {
            let score = p.completion ? Math.round(p.completion) : 0;
            totalScore += score;
            projectCount++;

            let scoreColor = score >= 100 ? '#27ae60' : (score > 0 ? '#f39c12' : '#e74c3c');
            tableRows += `
                <tr>
                    <td>${p.name}</td>
                    <td style="color: ${scoreColor}; font-weight: bold; width: 120px; text-align: right;">${score}%</td>
                </tr>`;
        });

        // Calcul de la moyenne du cursus
        let averageScore = projectCount > 0 ? Math.round(totalScore / projectCount) : 0;
        let avgColor = averageScore >= 100 ? '#27ae60' : (averageScore >= 80 ? '#f39c12' : '#e74c3c');

        contentHtml += `
            <div class="curriculum-section">
                <div class="curriculum-header">
                    <h2>${curriculum.name}</h2>
                    <div class="curriculum-average" style="color: ${avgColor};">Moyenne : ${averageScore}%</div>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Nom du Projet</th>
                            <th style="text-align: right;">Score</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                    </tbody>
                </table>
            </div>
        `;
    });

    return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333; margin: 40px; }
            .header { text-align: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 30px; }
            .header img { max-width: 250px; margin-bottom: 15px; }
            .header h1 { margin: 0; color: #E74C3C; font-size: 26px; }
            
            .info-section { margin-bottom: 30px; font-size: 16px; background-color: #f8fafc; padding: 20px; border-radius: 8px; border-left: 4px solid #E74C3C; }
            .info-section h3 { margin: 0 0 10px 0; color: #2c3e50; font-size: 22px; }
            
            .curriculum-section { margin-bottom: 40px; page-break-inside: avoid; }
            .curriculum-header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #E74C3C; padding-bottom: 8px; margin-bottom: 15px; }
            .curriculum-header h2 { font-size: 18px; color: #2c3e50; margin: 0; padding: 0; border: none; }
            .curriculum-average { font-size: 16px; font-weight: bold; }

            table { width: 100%; border-collapse: collapse; }
            th { background-color: #f8fafc; color: #475569; text-align: left; padding: 10px 12px; font-size: 13px; text-transform: uppercase; border-bottom: 2px solid #cbd5e1; }
            td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
            tr:nth-child(even) { background-color: #f8fafc; }
            
            .footer { margin-top: 50px; text-align: center; font-size: 12px; color: #94a3b8; }
        </style>
    </head>
    <body>
        <div class="header">
            ${logoHtml}
        </div>
        
        <div class="info-section">
            <h3>${fullName}</h3>
            <strong>ID Étudiant :</strong> ${studentId}<br>
            <strong>Date d'édition :</strong> ${dateStr}
        </div>
        
        ${contentHtml}

        <div class="footer">Document généré automatiquement le ${dateStr}.</div>
    </body>
    </html>`;
}

app.listen(PORT, () => {
    console.log(`Serveur démarré : http://localhost:${PORT}`);
});