import { z } from "zod";
import { SOURCE_IDS } from "./paper.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const queryField = z
  .string({ error: invalid })
  .trim()
  .min(1, { error: invalid })
  .max(300, { error: invalid });

const limitField = z
  .number({ error: invalid })
  .int({ error: invalid })
  .min(1, { error: invalid })
  .max(25, { error: invalid })
  .optional();

const pageField = z
  .number({ error: invalid })
  .int({ error: invalid })
  .min(1, { error: invalid })
  .max(200, { error: invalid })
  .optional();

const yearField = z
  .number({ error: invalid })
  .int({ error: invalid })
  .min(1500, { error: invalid })
  .max(2100, { error: invalid })
  .optional();

const shortText = (max: number) =>
  z.string({ error: invalid }).trim().min(1, { error: invalid }).max(max, { error: invalid });

const optionalShort = (max: number) => shortText(max).optional();

const sourceEnum = z.enum(SOURCE_IDS, { error: invalid });

const searchFields = {
  query: queryField,
  limit: limitField,
  yearFrom: yearField,
  yearTo: yearField,
  openAccessOnly: z.boolean({ error: invalid }).optional(),
  arxivCategory: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(40, { error: invalid })
    .regex(/^[A-Za-z][A-Za-z0-9.-]*$/, { error: invalid })
    .optional(),
};

export const searchPapersInput = z.object({
  ...searchFields,
  sources: z.array(sourceEnum, { error: invalid }).max(6, { error: invalid }).optional(),
});

export const searchSourceInput = z.object({
  ...searchFields,
  source: sourceEnum,
});

export const getPaperByDoiInput = z.object({
  doi: shortText(200),
});

export const getPaperInput = z.object({
  idType: z.enum(["arxiv", "pmid", "pmcid", "openalex"], { error: invalid }),
  id: shortText(100),
});

export const findOpenAccessInput = z.object({
  doi: shortText(200),
});

const graphFields = {
  doi: optionalShort(200),
  pmid: optionalShort(40),
  pmcid: optionalShort(40),
  openalexId: optionalShort(40),
  page: pageField,
  limit: limitField,
};

export const getCitationsInput = z.object(graphFields);
export const getReferencesInput = z.object(graphFields);

export const searchAuthorsInput = z.object({
  query: queryField,
  limit: limitField,
});

export const getAuthorWorksInput = z.object({
  openalexId: shortText(40),
  page: pageField,
  limit: limitField,
});

export const getFullTextInput = z.object({
  doi: optionalShort(200),
  pmid: optionalShort(40),
  pmcid: optionalShort(40),
  arxivId: optionalShort(80),
});

export const listSourcesInput = z.object({});

export const exportCitationInput = z.object({
  format: z.enum(["bibtex", "ris"], { error: invalid }),
  title: optionalShort(1000),
  doi: optionalShort(200),
  authors: z
    .array(
      z.object({
        name: shortText(200),
        orcid: optionalShort(40),
      }),
      { error: invalid },
    )
    .max(50, { error: invalid })
    .optional(),
  year: yearField,
  venue: optionalShort(300),
  abstract: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(8000, { error: invalid })
    .optional(),
});
