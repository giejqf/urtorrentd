// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { ValidComponent } from "solid-js";
import { mergeProps, splitProps } from "solid-js";

import type { PolymorphicProps } from "@kobalte/core";
import * as TextFieldPrimitive from "@kobalte/core/text-field";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

import { cn } from "~/lib/utils";

type TextFieldRootProps<T extends ValidComponent = "div"> =
  TextFieldPrimitive.TextFieldRootProps<T> & {
    class?: string | undefined;
  };

const TextField = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, TextFieldRootProps<T>>,
) => {
  const [local, others] = splitProps(props as TextFieldRootProps, ["class"]);
  return <TextFieldPrimitive.Root class={cn("flex flex-col gap-1.5", local.class)} {...others} />;
};

// `lg` is the sign-in field (40px, radius 8); `default` the compact one.
const inputVariants = cva(
  "flex w-full border border-input bg-background text-base text-foreground transition-[border-color,box-shadow] outline-none placeholder:text-faint focus-visible:border-ring focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 data-[invalid]:border-danger",
  {
    variants: {
      size: {
        default: "h-[30px] rounded-md px-2.5",
        md: "h-9 rounded-lg px-3",
        lg: "h-10 rounded-lg px-3",
      },
    },
    defaultVariants: { size: "default" },
  },
);

type TextFieldInputProps<T extends ValidComponent = "input"> =
  TextFieldPrimitive.TextFieldInputProps<T> &
    VariantProps<typeof inputVariants> & {
      class?: string | undefined;
      type?: "email" | "number" | "password" | "search" | "tel" | "text" | "url";
    };

const TextFieldInput = <T extends ValidComponent = "input">(
  rawProps: PolymorphicProps<T, TextFieldInputProps<T>>,
) => {
  const props = mergeProps<TextFieldInputProps<T>[]>({ type: "text" }, rawProps);
  const [local, others] = splitProps(props as TextFieldInputProps, ["type", "class", "size"]);
  return (
    <TextFieldPrimitive.Input
      type={local.type}
      class={cn(inputVariants({ size: local.size }), local.class)}
      {...others}
    />
  );
};

type TextFieldTextAreaProps<T extends ValidComponent = "textarea"> =
  TextFieldPrimitive.TextFieldTextAreaProps<T> & { class?: string | undefined };

const TextFieldTextArea = <T extends ValidComponent = "textarea">(
  props: PolymorphicProps<T, TextFieldTextAreaProps<T>>,
) => {
  const [local, others] = splitProps(props as TextFieldTextAreaProps, ["class"]);
  return (
    <TextFieldPrimitive.TextArea
      class={cn(
        "flex min-h-20 w-full rounded-md border border-input bg-background px-2.5 py-2 text-base text-foreground transition-[border-color,box-shadow] outline-none placeholder:text-faint focus-visible:border-ring focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 data-[invalid]:border-danger",
        local.class,
      )}
      {...others}
    />
  );
};

const labelVariants = cva("peer-disabled:cursor-not-allowed peer-disabled:opacity-70", {
  variants: {
    variant: {
      label: "text-sm font-medium text-foreground",
      description: "text-sm text-subtle",
      error: "text-sm text-danger",
    },
  },
  defaultVariants: {
    variant: "label",
  },
});

type TextFieldLabelProps<T extends ValidComponent = "label"> =
  TextFieldPrimitive.TextFieldLabelProps<T> & { class?: string | undefined };

const TextFieldLabel = <T extends ValidComponent = "label">(
  props: PolymorphicProps<T, TextFieldLabelProps<T>>,
) => {
  const [local, others] = splitProps(props as TextFieldLabelProps, ["class"]);
  return <TextFieldPrimitive.Label class={cn(labelVariants(), local.class)} {...others} />;
};

type TextFieldDescriptionProps<T extends ValidComponent = "div"> =
  TextFieldPrimitive.TextFieldDescriptionProps<T> & {
    class?: string | undefined;
  };

const TextFieldDescription = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, TextFieldDescriptionProps<T>>,
) => {
  const [local, others] = splitProps(props as TextFieldDescriptionProps, ["class"]);
  return (
    <TextFieldPrimitive.Description
      class={cn(labelVariants({ variant: "description" }), local.class)}
      {...others}
    />
  );
};

type TextFieldErrorMessageProps<T extends ValidComponent = "div"> =
  TextFieldPrimitive.TextFieldErrorMessageProps<T> & {
    class?: string | undefined;
  };

const TextFieldErrorMessage = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, TextFieldErrorMessageProps<T>>,
) => {
  const [local, others] = splitProps(props as TextFieldErrorMessageProps, ["class"]);
  return (
    <TextFieldPrimitive.ErrorMessage
      class={cn(labelVariants({ variant: "error" }), local.class)}
      {...others}
    />
  );
};

export {
  TextField,
  TextFieldInput,
  TextFieldTextArea,
  TextFieldLabel,
  TextFieldDescription,
  TextFieldErrorMessage,
  inputVariants,
};
