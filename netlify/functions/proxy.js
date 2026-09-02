// netlify/functions/proxy.js
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { SUBUNSUR_DATA } = require('./subunsur');

// ====== KONFIGURASI ======
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_DRIVE_ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const DELETE_PASSWORD = process.env.DELETE_PASSWORD;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// Validasi Environment Variables
const missingEnv = [];
if (!SUPABASE_URL) missingEnv.push('SUPABASE_URL');
if (!SUPABASE_KEY) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
if (!GOOGLE_DRIVE_ROOT_FOLDER_ID) missingEnv.push('GOOGLE_DRIVE_ROOT_FOLDER_ID');
if (!ACCESS_PASSWORD) missingEnv.push('ACCESS_PASSWORD');
if (!DELETE_PASSWORD) missingEnv.push('DELETE_PASSWORD');
if (!GOOGLE_SERVICE_ACCOUNT_JSON) missingEnv.push('GOOGLE_SERVICE_ACCOUNT_JSON');
if (missingEnv.length > 0) {
  throw new Error('Environment variables belum diisi: ' + missingEnv.join(', '));
}

// Inisialisasi Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== GOOGLE DRIVE ======
let drive = null;
function getDrive() {
  if (drive) return drive;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    drive = google.drive({ version: 'v3', auth });
  } catch (e) {
    throw new Error('Google auth gagal: ' + e.message);
  }
  return drive;
}

// ====== HELPER GOOGLE DRIVE ======
async function getOrCreateFolder(parentId, folderName) {
  const res = await getDrive().files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}'`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const folder = await getDrive().files.create({
    resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return folder.data.id;
}

async function uploadFileToDrive({ fileData, fileName, year, opdName, subunsur, paramId, paramLabel, level }) {
  const bytes = Buffer.from(fileData, 'base64');
  const fileSizeMB = bytes.length / (1024 * 1024);
  if (fileSizeMB > 20) throw new Error('Ukuran file melebihi 20 MB');

  const yearFolder = await getOrCreateFolder(GOOGLE_DRIVE_ROOT_FOLDER_ID, `year_${year}`);
  const opdFolder = await getOrCreateFolder(yearFolder, opdName);
  const unsurMap = {
    '1': '1. LINGKUNGAN PENGENDALIAN',
    '2': '2. PENILAIAN RISIKO',
    '3': '3. KEGIATAN PENGENDALIAN',
    '4': '4. INFORMASI DAN KOMUNIKASI',
    '5': '5. EVALUASI DAN PEMANTAUAN'
  };
  const unsurCode = subunsur.split('.')[0];
  const unsurFolder = await getOrCreateFolder(opdFolder, unsurMap[unsurCode] || `Unsur ${unsurCode}`);
  const subUnsurFolder = await getOrCreateFolder(unsurFolder, subunsur);

  let paramName = paramLabel;
  if (paramName.includes(' - ')) paramName = paramName.split(' - ')[1];
  else if (paramName.includes('-')) paramName = paramName.split('-')[1];
  if (!paramName || paramName.trim() === '') paramName = paramId;
  paramName = paramName.trim();
  const paramFolder = await getOrCreateFolder(subUnsurFolder, paramName);
  const levelFolder = await getOrCreateFolder(paramFolder, `Level ${level}`);

  const uniqueName = Date.now() + '_' + fileName;
  const file = await getDrive().files.create({
    resource: { name: uniqueName, parents: [levelFolder] },
    media: { mimeType: 'application/octet-stream', body: bytes },
    fields: 'id, webViewLink',
  });
  return `https://drive.google.com/file/d/${file.data.id}/view`;
}

async function deleteFileFromDrive(fileUrl) {
  const fileId = fileUrl.match(/[-\w]{25,}/)[0];
  await getDrive().files.delete({ fileId });
}

// ====== HELPER MAPPING NAMA FIELD ======
// Fungsi ini mengubah format data dari database agar sesuai dengan format frontend
function mapDatabaseRowToFrontend(row) {
  if (!row) return row;
  return {
    ...row,
    qaApip: row.qa_apip || row.qaApip || 'Belum', // Ambil dari qa_apip (DB) atau qaApip (jika sudah ada)
    qa_apip: row.qa_apip || row.qaApip || 'Belum', // Biarkan juga tersedia
  };
}

// Fungsi ini mengubah format data dari frontend agar sesuai dengan format database
function mapFrontendRowToDatabase(row) {
  if (!row) return row;
  return {
    ...row,
    qa_apip: row.qaApip || row.qa_apip || 'Belum', // Simpan ke qa_apip
  };
}

// Daftar field yang diizinkan untuk di-update
const ALLOWED_FIELDS = ['sa', 'evidence', 'qa_apip', 'qaApip', 'mri', 'iepk', 'rtp', 'status', 'opd', 'subunsurs'];

// ====== HANDLER UTAMA ======
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };

  // PARSING BODY YANG TAHAN BANTING (MENGATASI part.body.pipe)
  let params = {};
  try {
    let bodyStr = event.body || '';
    // Jika Netlify mengirim body sebagai base64 (kadang terjadi), decode dulu
    if (event.isBase64Encoded) {
      bodyStr = Buffer.from(bodyStr, 'base64').toString('utf8');
    }
    if (bodyStr) {
      params = JSON.parse(bodyStr);
    } else if (event.queryStringParameters) {
      params = event.queryStringParameters;
    }
  } catch (e) {
    return jsonRes({ status: 'error', message: 'Format body tidak valid' }, headers);
  }

  const action = params.action || '';
  const year = params.year || '2026';

  try {
    switch (action) {
      case 'verifyAccess':
        return jsonRes({ status: params.password === ACCESS_PASSWORD ? 'success' : 'error', message: params.password === ACCESS_PASSWORD ? 'Akses diterima' : 'Password salah' }, headers);

      case 'verifyDelete':
        return jsonRes({ status: params.password === DELETE_PASSWORD ? 'success' : 'error', message: params.password === DELETE_PASSWORD ? 'Password hapus benar' : 'Password hapus salah' }, headers);

      case 'getData': {
        const { data, error } = await supabase.from('opd_data').select('*').eq('year', year);
        if (error) throw error;
        // MAPPING: qa_apip -> qaApip agar frontend membaca dengan benar
        const mappedData = (data || []).map(mapDatabaseRowToFrontend);
        return jsonRes(mappedData, headers);
      }

      case 'saveData': {
        const rows = JSON.parse(params.rows);
        if (!Array.isArray(rows)) throw new Error('Format rows tidak valid');
        for (const row of rows) {
          // MAPPING: qaApip -> qa_apip agar database menyimpan dengan benar
          const payload = mapFrontendRowToDatabase({
            id: row.id,
            opd: row.opd || '',
            sa: parseFloat(row.sa) || 0,
            evidence: row.evidence || 'Belum',
            qa_apip: row.qaApip || row.qa_apip || 'Belum',
            mri: parseFloat(row.mri) || 0,
            iepk: parseFloat(row.iepk) || 0,
            rtp: row.rtp || 'Belum',
            status: row.status || 'Belum',
            subunsurs: row.subunsurs || {},
            year: year
          });
          const { error } = await supabase.from('opd_data').upsert(payload, { onConflict: 'id' });
          if (error) throw error;
        }
        return jsonRes({ status: 'success', message: 'Data berhasil disimpan' }, headers);
      }

      case 'saveField': {
        const { opdId, field, value } = params;
        if (!opdId || !field) return jsonRes({ status: 'error', message: 'Parameter opdId dan field wajib diisi' }, headers);
        if (!ALLOWED_FIELDS.includes(field)) return jsonRes({ status: 'error', message: `Field '${field}' tidak diizinkan` }, headers);

        // MAPPING: qaApip -> qa_apip (dan sebaliknya)
        const fieldMap = {
          'qaApip': 'qa_apip',
          'qa_apip': 'qa_apip'
        };
        const dbField = fieldMap[field] || field;

        const updateObj = {};
        updateObj[dbField] = value;

        const { error } = await supabase.from('opd_data').update(updateObj).eq('id', opdId);
        if (error) throw error;
        return jsonRes({ status: 'success', message: 'Field berhasil disimpan' }, headers);
      }

      case 'deleteOpd': {
        const { opdId } = params;
        if (!opdId) return jsonRes({ status: 'error', message: 'Parameter opdId wajib diisi' }, headers);
        if (opdId === 'all') await supabase.from('opd_data').delete().eq('year', year);
        else await supabase.from('opd_data').delete().eq('id', opdId);
        return jsonRes({ status: 'success', message: 'OPD berhasil dihapus' }, headers);
      }

      case 'getYears': {
        const { data } = await supabase.from('years').select('year');
        const years = data.map(item => item.year);
        if (!years.includes('2026')) years.push('2026');
        const uniqueYears = [...new Set(years)].sort((a,b) => b.localeCompare(a));
        return jsonRes(uniqueYears, headers);
      }

      case 'addYear': {
        const newYear = params.year;
        if (!/^\d{4}$/.test(newYear)) return jsonRes({ status: 'error', message: 'Tahun tidak valid' }, headers);
        const { error } = await supabase.from('years').insert({ year: newYear });
        if (error) throw error;
        return jsonRes({ status: 'success', message: 'Tahun berhasil ditambahkan' }, headers);
      }

      case 'deleteYear': {
        const delYear = params.year;
        if (delYear === '2026') return jsonRes({ status: 'error', message: 'Tahun default tidak boleh dihapus' }, headers);
        await supabase.from('opd_data').delete().eq('year', delYear);
        await supabase.from('years').delete().eq('year', delYear);
        return jsonRes({ status: 'success', message: 'Tahun berhasil dihapus' }, headers);
      }

      case 'uploadFile': {
        const fileUrl = await uploadFileToDrive(params);
        return jsonRes(fileUrl, headers);
      }

      case 'deleteFile': {
        if (!params.fileUrl) return jsonRes({ status: 'error', message: 'Parameter fileUrl wajib diisi' }, headers);
        await deleteFileFromDrive(params.fileUrl);
        return jsonRes({ status: 'success', message: 'File dihapus' }, headers);
      }

      case 'createBackup': {
        const { data: rows } = await supabase.from('opd_data').select('*').eq('year', year);
        const folderId = await getOrCreateFolder(GOOGLE_DRIVE_ROOT_FOLDER_ID, `year_${year}`);
        const backupFolder = await getOrCreateFolder(folderId, 'backup');
        const timestamp = new Date().toISOString().replace(/[-:T]/g, '_').slice(0, 19);
        const fileName = `backup_${timestamp}.json`;
        await getDrive().files.create({
          resource: { name: fileName, parents: [backupFolder] },
          media: { mimeType: 'application/json', body: JSON.stringify(rows) },
          fields: 'id',
        });
        return jsonRes({ status: 'success', message: 'Backup berhasil dibuat', fileName }, headers);
      }

      case 'listBackups': {
        const folderId = await getOrCreateFolder(GOOGLE_DRIVE_ROOT_FOLDER_ID, `year_${year}`);
        const backupFolder = await getOrCreateFolder(folderId, 'backup');
        const res = await getDrive().files.list({
          q: `'${backupFolder}' in parents and trashed=false`,
          fields: 'files(id, name, size, createdTime)',
          orderBy: 'createdTime desc',
        });
        const backups = res.data.files.map(file => ({
          fileName: file.name,
          timestamp: file.createdTime,
          size: Math.round(file.size / 1024),
          count: 0
        }));
        return jsonRes(backups, headers);
      }

      case 'restoreBackup': {
        const { fileName } = params;
        if (!fileName) return jsonRes({ status: 'error', message: 'Parameter fileName wajib diisi' }, headers);
        const folderId = await getOrCreateFolder(GOOGLE_DRIVE_ROOT_FOLDER_ID, `year_${year}`);
        const backupFolder = await getOrCreateFolder(folderId, 'backup');
        const res = await getDrive().files.list({
          q: `'${backupFolder}' in parents and name='${fileName}' and trashed=false`,
          fields: 'files(id)',
        });
        if (res.data.files.length === 0) return jsonRes({ status: 'error', message: 'Backup tidak ditemukan' }, headers);
        const fileId = res.data.files[0].id;
        const content = await getDrive().files.get({ fileId, alt: 'media' });
        const rows = JSON.parse(content.data);
        await supabase.from('opd_data').delete().eq('year', year);
        for (const row of rows) {
          const { error } = await supabase.from('opd_data').insert(row);
          if (error) throw error;
        }
        return jsonRes({ status: 'success', message: 'Backup berhasil dipulihkan' }, headers);
      }

      case 'deleteBackup': {
        const { fileName } = params;
        if (!fileName) return jsonRes({ status: 'error', message: 'Parameter fileName wajib diisi' }, headers);
        const folderId = await getOrCreateFolder(GOOGLE_DRIVE_ROOT_FOLDER_ID, `year_${year}`);
        const backupFolder = await getOrCreateFolder(folderId, 'backup');
        const res = await getDrive().files.list({
          q: `'${backupFolder}' in parents and name='${fileName}' and trashed=false`,
          fields: 'files(id)',
        });
        if (res.data.files.length > 0) await getDrive().files.delete({ fileId: res.data.files[0].id });
        return jsonRes({ status: 'success', message: 'Backup dihapus' }, headers);
      }

      case 'getSubunsurData':
        return jsonRes(SUBUNSUR_DATA, headers);

      default:
        return jsonRes({ status: 'error', message: `Aksi '${action}' tidak dikenal` }, headers);
    }
  } catch (err) {
    console.error('Error di Netlify Function:', err);
    return jsonRes({ status: 'error', message: 'Terjadi kesalahan: ' + err.message }, headers);
  }
};

function jsonRes(obj, headers) {
  return { statusCode: 200, headers, body: JSON.stringify(obj) };
}
