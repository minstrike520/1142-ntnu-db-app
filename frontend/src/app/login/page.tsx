"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { login } from "@/lib/api";

const getFriendlyLoginError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";

  if (message === "Failed to fetch" || message.includes("fetch")) {
    return "Cannot connect to server. Please verify the system service is running and try again.";
  }

  return message || "Login failed, please try again later.";
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    document.title = "Near | Sign In";
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter Email and password.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setIsSubmitting(true);
    setError("");
    try {
      const result = await login({ email, password });
      localStorage.setItem(
        "user",
        JSON.stringify({
          userId: result.user.userId,
          username: result.user.name,
          email,
          avatar: result.user.avatarUrl ?? "",
        }),
      );
      router.push("/");
    } catch (err) {
      setError(getFriendlyLoginError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-4 bg-background transition-colors overflow-y-auto">
      <div className="w-full max-w-sm border border-border-primary rounded-sm bg-surface-card p-8 flex flex-col items-center">
        <div className="size-16 bg-surface-muted rounded-sm flex items-center justify-center mb-6 overflow-hidden">
          <Image
            src="/near.png"
            alt="Near logo"
            width={128}
            height={128}
            className="object-contain size-full"
          />
        </div>

        <h1 className="text-xl font-bold uppercase tracking-wider text-foreground mb-1 select-none font-sans">
          Near
        </h1>
        <p className="text-xs text-text-muted select-none font-sans mb-8">
          Sign in to Near
        </p>

        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-5">
          <Input
            label="Email"
            type="email"
            placeholder="your email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError("");
            }}
            required
          />

          <Input
            label="Password"
            type="password"
            placeholder="your password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError("");
            }}
            required
          />

          {error && (
            <p className="text-xs text-red-600 font-sans text-center">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full mt-2 py-3 select-none font-sans"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Signing in..." : "Sign In"}
          </Button>
        </form>

        <div className="w-full text-center mt-6 pt-6 border-t border-border-secondary">
          <p className="text-xs text-text-muted font-sans select-none">
            No account yet?{" "}
            <Link
              href="/register"
              className="text-primary font-semibold hover:underline"
            >
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
