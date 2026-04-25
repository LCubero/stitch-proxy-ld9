import { describe, expect, test } from 'vitest';

import { normalizeJsonSchema } from '../src/schema-normalizer.js';

describe('normalizeJsonSchema', () => {
  test('transforms $ref with description into allOf wrapper', () => {
    const schema = {
      $ref: '#/$defs/VariantOptions',
      description: 'Variant configuration for this element.',
    };

    expect(normalizeJsonSchema(schema)).toEqual({
      allOf: [{ $ref: '#/$defs/VariantOptions' }],
      description: 'Variant configuration for this element.',
    });
  });

  test('leaves pure $ref untouched', () => {
    const schema = {
      $ref: '#/$defs/VariantOptions',
    };

    expect(normalizeJsonSchema(schema)).toEqual(schema);
  });

  test('normalizes nested properties and array items recursively', () => {
    const schema = {
      properties: {
        variants: {
          items: {
            $ref: '#/$defs/VariantOption',
            description: 'One allowed variant option.',
          },
          type: 'array',
        },
      },
      type: 'object',
    };

    expect(normalizeJsonSchema(schema)).toEqual({
      properties: {
        variants: {
          items: {
            allOf: [{ $ref: '#/$defs/VariantOption' }],
            description: 'One allowed variant option.',
          },
          type: 'array',
        },
      },
      type: 'object',
    });
  });

  test('does not mutate the input object', () => {
    const schema = {
      $defs: {
        VariantOption: {
          type: 'string',
        },
      },
      properties: {
        option: {
          $ref: '#/$defs/VariantOption',
          title: 'Selected option',
        },
      },
      type: 'object',
    };

    const original = structuredClone(schema);
    const normalized = normalizeJsonSchema(schema);

    expect(schema).toEqual(original);
    expect(normalized).not.toBe(schema);
    expect(normalized).toEqual({
      $defs: {
        VariantOption: {
          type: 'string',
        },
      },
      properties: {
        option: {
          allOf: [{ $ref: '#/$defs/VariantOption' }],
          title: 'Selected option',
        },
      },
      type: 'object',
    });
  });
});
