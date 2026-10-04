import type { ChatAttachment } from './api';

export const readAttachment = (file: File, name: string): Promise<ChatAttachment> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve({ name, type: file.type || 'application/octet-stream', size: file.size, encoding: 'data-url', content: reader.result }) : reject(new Error('Invalid attachment content')); reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment')); reader.readAsDataURL(file); });
