/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as React from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export interface ToastContainerProps {
  toasts: ToastMessage[];
  onRemoveToast: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({
  toasts,
  onRemoveToast
}) => {
  React.useEffect(() => {
    toasts.forEach(toast => {
      if (toast.duration !== 0) { // 0 means permanent
        const timeout = setTimeout(() => {
          onRemoveToast(toast.id);
        }, toast.duration || 5000);
        
        return () => clearTimeout(timeout);
      }
    });
  }, [toasts, onRemoveToast]);

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div 
          key={toast.id}
          className={`toast toast-${toast.type}`}
          onClick={() => onRemoveToast(toast.id)}
        >
          <div className="toast-content">
            {toast.message}
          </div>
          <div className="toast-close">×</div>
        </div>
      ))}
    </div>
  );
};

export const useToast = () => {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);

  const addToast = React.useCallback((type: ToastType, message: string, duration?: number) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const toast: ToastMessage = { id, type, message, duration };
    
    setToasts(prev => [...prev, toast]);
    return id;
  }, []);

  const removeToast = React.useCallback((id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const showSuccess = React.useCallback((message: string) => 
    addToast('success', message, 3000), [addToast]);
    
  const showError = React.useCallback((message: string) => 
    addToast('error', message, 5000), [addToast]);
    
  const showInfo = React.useCallback((message: string) => 
    addToast('info', message, 4000), [addToast]);

  return {
    toasts,
    addToast,
    removeToast,
    showSuccess,
    showError,
    showInfo
  };
};
