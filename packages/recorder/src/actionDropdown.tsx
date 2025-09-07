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

const actions = [
  'click',
  'dblclick', 
  'fill',
  'press',
  'check',
  'uncheck',
  'selectOption',
  'hover',
  'scroll'
] as const;

const extractions = [
  'innerText',
  'textContent',
  'getAttribute',
  'isVisible',
  'isEnabled', 
  'isChecked',
  'count',
  'boundingBox'
] as const;

export interface ActionDropdownProps {
  value: string;
  onChange: (value: string) => void;
  onTypeChange: (type: 'action' | 'extraction') => void;
  type: 'action' | 'extraction';
}

export const ActionDropdown: React.FC<ActionDropdownProps> = ({
  value,
  onChange,
  onTypeChange,
  type
}) => {
  const options = type === 'action' ? actions : extractions;
  
  return (
    <div className="action-dropdown">
      <select 
        value={type}
        onChange={(e) => {
          const newType = e.target.value as 'action' | 'extraction';
          onTypeChange(newType);
          // Set default value for new type
          if (newType === 'action') {
            onChange('click');
          } else {
            onChange('innerText');
          }
        }}
        className="action-type-select"
      >
        <option value="action">Actions</option>
        <option value="extraction">Extractions</option>
      </select>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="operation-select"
      >
        {options.map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
};
