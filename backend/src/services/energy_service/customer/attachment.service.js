const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getPrivateUploadsDir } = require('../../../config/shared');
const AppError = require('../../../utils/energy_service/AppError');
const attachmentModel = require('../../../models/energy_service/customer/attachment.model');
const presenters = require('./presenters');
const support = require('./support');

const ATTACHMENT_DIR = path.join(getPrivateUploadsDir(), 'customer-attachments');
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const hasOleSignature = (buffer) => buffer.subarray(0, 8).equals(Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]));
const hasZipSignature = (buffer) => buffer[0] === 0x50
  && buffer[1] === 0x4b
  && [0x03, 0x05, 0x07].includes(buffer[2])
  && [0x04, 0x06, 0x08].includes(buffer[3]);
const hasTextSignature = (buffer) => !buffer.includes(0)
  && !buffer.toString('utf8').includes('\ufffd');
const hasDwgSignature = (buffer) => /^AC10\d{2}$/.test(buffer.toString('ascii', 0, 6));
const hasDxfSignature = (buffer) => /^0\r?\nSECTION\r?\n2\r?\n[A-Z]+\r?\n/.test(buffer.toString('ascii', 0, 128));
const FILE_TYPES = {
  'image/jpeg': { extension: 'jpg', signature: (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/png': { extension: 'png', signature: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/webp': { extension: 'webp', signature: (buffer) => buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
  'application/pdf': { extension: 'pdf', signature: (buffer) => buffer.toString('ascii', 0, 5) === '%PDF-' },
  'application/acad': { extension: 'dwg', signature: hasDwgSignature },
  'application/dxf': { extension: 'dxf', signature: hasDxfSignature },
  'image/vnd.dwg': { extension: 'dwg', signature: hasDwgSignature },
  'image/vnd.dxf': { extension: 'dxf', signature: hasDxfSignature },
  'application/msword': { extension: 'doc', signature: hasOleSignature },
  'application/vnd.ms-excel': { extension: 'xls', signature: hasOleSignature },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extension: 'docx', signature: hasZipSignature },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extension: 'xlsx', signature: hasZipSignature },
  'text/plain': { extension: 'txt', signature: hasTextSignature },
};

function fileBuffer(body) {
  const mimeType = String(body.mimeType || body.contentType || '').toLowerCase();
  const type = FILE_TYPES[mimeType];
  if (!type) {
    throw new AppError('Upload an image, PDF, CAD drawing, or supported office document.', 422, 'UNSUPPORTED_FILE_TYPE');
  }
  const encoded = body.contentBase64;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new AppError('The uploaded file could not be decoded.', 422, 'INVALID_FILE_CONTENT');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length < 64 || buffer.length > MAX_FILE_BYTES) {
    throw new AppError('Files must be between 64 bytes and 4 MB.', 422, 'FILE_SIZE_INVALID');
  }
  if (!type.signature(buffer)) {
    throw new AppError('The file content does not match its declared type.', 422, 'FILE_TYPE_MISMATCH');
  }
  const fileExtension = path.extname(String(body.fileName || '')).slice(1).toLowerCase();
  if (fileExtension !== type.extension) {
    throw new AppError('The file name extension does not match its content type.', 422, 'FILE_TYPE_MISMATCH');
  }
  if (body.byteSize !== undefined && body.byteSize !== buffer.length) {
    throw new AppError('The uploaded file size does not match its content.', 422, 'FILE_SIZE_MISMATCH');
  }
  return { buffer, mimeType, extension: type.extension };
}

async function register(user, body, req) {
  support.assertIdentity(user, body);
  const companyId = support.companyIdOf(user);
  if (body.contentBase64) {
    const { buffer, mimeType, extension } = fileBuffer(body);
    const storageKey = `${crypto.randomUUID()}.${extension}`;
    const filePath = path.join(ATTACHMENT_DIR, storageKey);
    await fsPromises.mkdir(ATTACHMENT_DIR, { recursive: true });
    await fsPromises.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
    let row;
    try {
      row = await attachmentModel.insert({
        companyId,
        uploadedBy: user.id,
        fileName: body.fileName,
        mimeType,
        fileReference: `local/${storageKey}`,
        byteSize: buffer.length,
      });
    } catch (err) {
      try {
        await fsPromises.unlink(filePath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          console.error('Failed to remove unattached upload:', cleanupError.code || cleanupError.name);
        }
      }
      support.mapDbError(err);
    }
    await support.audit(req, user, 'customer.attachment.upload', 'customer_attachment', row.id, null, 'Attachment file uploaded.');
    return { attachment: presenters.attachment(row) };
  }
  try {
    const row = await attachmentModel.insert({
      companyId,
      uploadedBy: user.id,
      fileName: body.fileName,
      mimeType: body.mimeType || body.contentType,
      fileReference: body.fileReference || body.storageKey,
      byteSize: body.byteSize,
    });
    await support.audit(req, user, 'customer.attachment.create', 'customer_attachment', row.id, null, 'Attachment reference saved.');
    return { attachment: presenters.attachment(row) };
  } catch (err) {
    support.mapDbError(err);
  }
}

async function list(user, query) {
  const companyId = support.companyIdOf(user);
  if (!query.entityType || !query.entityId) {
    throw new AppError('Choose the record whose attachments you want.', 422, 'VALIDATION_ERROR');
  }
  const rows = await attachmentModel.listByEntity(companyId, query.entityType, query.entityId);
  return { attachments: rows.map(presenters.attachment) };
}

async function openContent(user, id) {
  const companyId = support.companyIdOf(user);
  const row = await attachmentModel.findById(companyId, id);
  if (!row) throw new AppError('The attachment was not found.', 404, 'ATTACHMENT_NOT_FOUND');
  const match = /^local\/([0-9a-f-]{36}\.(?:jpg|png|webp|pdf|dwg|dxf|doc|docx|xls|xlsx|txt))$/i.exec(row.file_reference);
  if (!match) {
    throw new AppError('This attachment is stored by an external provider and cannot be downloaded here.', 501, 'ATTACHMENT_PROVIDER_UNAVAILABLE');
  }
  const filePath = path.join(ATTACHMENT_DIR, match[1]);
  let stats;
  try {
    stats = await fsPromises.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new AppError('The stored attachment file is missing.', 404, 'ATTACHMENT_CONTENT_NOT_FOUND');
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw new AppError('The stored attachment file is unavailable.', 404, 'ATTACHMENT_CONTENT_NOT_FOUND');
  }
  return {
    stream: fs.createReadStream(filePath),
    mimeType: row.mime_type,
    byteSize: stats.size,
    downloadName: row.file_name.replace(/[^\x20-\x7e]|["\\]/g, '_'),
  };
}

module.exports = { register, list, openContent, fileBuffer };
