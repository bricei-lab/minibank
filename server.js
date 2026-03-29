const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ====================================================
// ÉTAGE 3 — Connexion à la base de données PostgreSQL
// ====================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware de logging — ÉTAGE 6 (Sécurité / Monitoring)
// Chaque requête API est enregistrée avec sa méthode, son URL et la date
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.url} → ${res.statusCode} (${duration}ms)`
    );
  });
  next();
});

// ====================================================
// ÉTAGE 4 — LES APIs REST
// Chaque endpoint est comme un "service" du SI
// ====================================================

// --- API 1 : Lister tous les clients ---
// GET = "donne-moi une information" (lecture)
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nom, prenom, email, date_creation FROM clients ORDER BY nom'
    );
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API 2 : Voir les comptes d'un client ---
// Le :clientId dans l'URL est un paramètre dynamique
app.get('/api/clients/:clientId/comptes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT co.id, co.type_compte, co.solde, co.iban, co.date_ouverture
       FROM comptes co
       WHERE co.client_id = $1
       ORDER BY co.type_compte`,
      [req.params.clientId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API 3 : Effectuer un virement ---
// POST = "crée quelque chose" (écriture)
// C'est ici qu'on voit les propriétés ACID en action !
app.post('/api/virements', async (req, res) => {
  const { compte_source_id, compte_dest_id, montant, libelle } = req.body;

  // On utilise une TRANSACTION SQL — c'est l'Atomicité de ACID
  // Soit TOUT passe (débit + crédit + enregistrement), soit RIEN ne passe
  const client = await pool.connect();
  try {
    await client.query('BEGIN');  // Début de la transaction

    // 1. Vérifier le solde du compte source
    const sourceResult = await client.query(
      'SELECT solde FROM comptes WHERE id = $1 FOR UPDATE',
      // FOR UPDATE = on "verrouille" la ligne pour que personne
      // d'autre ne la modifie en même temps (Isolation de ACID)
      [compte_source_id]
    );

    if (sourceResult.rows.length === 0) {
      throw new Error('Compte source introuvable');
    }

    const soldeSource = parseFloat(sourceResult.rows[0].solde);
    if (soldeSource < montant) {
      throw new Error(`Solde insuffisant: ${soldeSource}€ disponibles, ${montant}€ demandés`);
    }

    // 2. Débiter le compte source
    await client.query(
      'UPDATE comptes SET solde = solde - $1 WHERE id = $2',
      [montant, compte_source_id]
    );

    // 3. Créditer le compte destination
    await client.query(
      'UPDATE comptes SET solde = solde + $1 WHERE id = $2',
      [montant, compte_dest_id]
    );

    // 4. Enregistrer le virement
    const virementResult = await client.query(
      `INSERT INTO virements (compte_source_id, compte_dest_id, montant, libelle, statut, date_execution)
       VALUES ($1, $2, $3, $4, 'execute', NOW())
       RETURNING *`,
      [compte_source_id, compte_dest_id, montant, libelle]
    );

    await client.query('COMMIT');  // Tout a réussi → on valide

    res.json({
      success: true,
      message: `Virement de ${montant}€ exécuté avec succès`,
      virement: virementResult.rows[0]
    });

  } catch (err) {
    await client.query('ROLLBACK');  // Erreur → on annule TOUT
    res.status(400).json({
      success: false,
      error: err.message
    });
  } finally {
    client.release();
  }
});

// --- API 4 : Historique des virements ---
app.get('/api/virements', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT v.id, v.montant, v.libelle, v.statut, v.date_execution,
              cs.iban as iban_source, cd.iban as iban_dest,
              cls.prenom || ' ' || cls.nom as nom_source,
              cld.prenom || ' ' || cld.nom as nom_dest
       FROM virements v
       JOIN comptes cs ON v.compte_source_id = cs.id
       JOIN comptes cd ON v.compte_dest_id = cd.id
       JOIN clients cls ON cs.client_id = cls.id
       JOIN clients cld ON cd.client_id = cld.id
       ORDER BY v.date_creation DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API 5 : Dashboard — statistiques globales ---
app.get('/api/dashboard', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM clients) as total_clients,
        (SELECT COUNT(*) FROM comptes) as total_comptes,
        (SELECT COALESCE(SUM(solde), 0) FROM comptes) as total_encours,
        (SELECT COUNT(*) FROM virements) as total_virements,
        (SELECT COALESCE(SUM(montant), 0) FROM virements WHERE statut = 'execute') as volume_virements
    `);
    res.json({ success: true, data: stats.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API 6 : Monitoring / Health check ---
// C'est ce que le load balancer utilise pour vérifier que le serveur est vivant
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      uptime: process.uptime()
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

// ====================================================
// ÉTAGE 1 — Le serveur web écoute sur un PORT
// ====================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[MiniBank] Serveur démarré sur le port ${PORT}`);
  console.log(`[MiniBank] APIs disponibles:`);
  console.log(`  GET  /api/clients`);
  console.log(`  GET  /api/clients/:id/comptes`);
  console.log(`  POST /api/virements`);
  console.log(`  GET  /api/virements`);
  console.log(`  GET  /api/dashboard`);
  console.log(`  GET  /api/health`);
});
