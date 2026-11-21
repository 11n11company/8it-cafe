import React, { useRef, useState } from 'react';
import { ImagePlus, Trash2, Upload } from 'lucide-react';
import { api } from '../../services/api';

const MAX_SIDE = 800;           // longest edge after resizing
const JPEG_QUALITY = 0.85;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/**
 * Resizes an image file in the browser to at most MAX_SIDE px and re-encodes it as JPEG,
 * so uploads stay small (typically 50–200 KB) and fast on the POS tablet.
 */
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF'; // flatten transparent PNGs onto white
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not process this image.'))),
        'image/jpeg',
        JPEG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('This file is not a readable image.'));
    };
    img.src = objectUrl;
  });
}

/**
 * Product photo picker: preview + upload / change / remove.
 * value: current image URL (uploaded path or legacy external URL); onChange(url | '').
 */
export function ProductImageUpload({ value, onChange, disabled = false }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const handleFile = async (file) => {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file (JPG, PNG or WebP).');
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError('That photo is too large. Please choose one under 15 MB.');
      return;
    }
    setUploading(true);
    try {
      const blob = await resizeImage(file);
      const res = await api.media.uploadProductImage(blob);
      const url = res?.data?.url;
      if (!url) throw new Error('Upload failed. Please try again.');
      setPreviewFailed(false);
      onChange(url);
    } catch (err) {
      setError(err.message || 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const hasImage = Boolean(value) && !previewFailed;

  return (
    <div className="product-image-upload">
      <div className="product-image-upload__preview" aria-hidden={!hasImage}>
        {hasImage ? (
          <img src={value} alt="Product" onError={() => setPreviewFailed(true)} />
        ) : (
          <ImagePlus className="ui-icon" aria-hidden="true" />
        )}
      </div>

      <div className="product-image-upload__body">
        <div className="product-image-upload__actions">
          <button
            type="button"
            className="ui-btn ui-btn--secondary ui-btn--sm"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || uploading}
          >
            {uploading ? <span className="ui-spinner" aria-hidden="true" /> : <Upload className="ui-icon" aria-hidden="true" />}
            {uploading ? 'Uploading…' : value ? 'Change photo' : 'Upload photo'}
          </button>
          {value && !uploading && (
            <button
              type="button"
              className="ui-btn ui-btn--ghost ui-btn--sm"
              onClick={() => {
                setError(null);
                setPreviewFailed(false);
                onChange('');
              }}
              disabled={disabled}
              style={{ color: 'var(--color-danger)' }}
            >
              <Trash2 className="ui-icon" aria-hidden="true" />
              Remove
            </button>
          )}
        </div>
        <span className="form-hint">JPG, PNG or WebP. Resized automatically for the POS.</span>
        {previewFailed && value && <span className="form-error">The current image could not be loaded. Upload a new photo.</span>}
        {error && <span className="form-error">{error}</span>}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/*"
        hidden
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </div>
  );
}

export default ProductImageUpload;
