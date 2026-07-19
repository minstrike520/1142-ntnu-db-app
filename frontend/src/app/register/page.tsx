"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { register } from "@/lib/api";

const getFriendlyRegisterError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";

  if (message === "Failed to fetch" || message.includes("fetch")) {
    return "Cannot connect to server. Please verify the system service is running and try again.";
  }

  return message || "Registration failed. Please try again.";
};

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    document.title = "Near | Register";
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !email || !password || !confirmPassword) {
      setError("Please complete all fields.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    setError("");
    try {
      const result = await register({ name: username, email, password });
      localStorage.setItem(
        "user",
        JSON.stringify({
          userId: result.user.userId,
          username: result.user.name,
          email,
          avatar: result.user.avatarUrl ?? "",
        }),
      );
      localStorage.setItem("just_registered", "true");
      router.push("/");
    } catch (err) {
      setError(getFriendlyRegisterError(err));
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

        <h1 className="text-xl font-bold uppercase tracking-wider text-foreground mb-1 select-none font-sans text-center">
          Create account
        </h1>
        <p className="text-xs text-text-muted select-none font-sans mb-8">
          Join Near
        </p>

        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4">
          <Input
            label="Name"
            type="text"
            placeholder="Display name"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setError("");
            }}
            required
          />

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

          <Input
            label="Confirm password"
            type="password"
            placeholder="Repeat password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setError("");
            }}
            required
          />

          {error && (
            <p className="text-xs text-red-600 font-sans text-center mt-1">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full mt-3 py-3 select-none font-sans"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Creating..." : "Create account"}
          </Button>
        </form>

        <div className="w-full text-center mt-6 pt-6 border-t border-border-secondary">
          <p className="text-xs text-text-muted font-sans select-none">
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-primary font-semibold hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
