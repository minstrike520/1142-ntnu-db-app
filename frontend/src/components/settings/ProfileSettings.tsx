"use client";

import React, { useEffect, useRef, useState } from "react";
import { UiLanguage, useChat, PreferencesInput } from "@/context/ChatContext";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";
import FeedbackMessage, { SettingsFeedback } from "@/components/settings/FeedbackMessage";
import SectionTitle from "@/components/settings/SectionTitle";
import { useTranslation } from "@/hooks/useTranslation";

const ACCEPTED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const AVATAR_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

export default function ProfileSettings() {
  const { t } = useTranslation();
  const { user, uiLanguage, handleUpdateProfile, handleUpdatePreferences, handleDeleteAccount, setHasUnsavedChanges, handleLogout } = useChat();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [personalUsername, setPersonalUsername] = useState("");
  const [personalEmail, setPersonalEmail] = useState("");
  const [personalAvatar, setPersonalAvatar] = useState("");
  const [personalAvatarFile, setPersonalAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [personalBio, setPersonalBio] = useState("");
  const bioError = (() => {
    if (personalBio.length > 100) {
      return t("profile.bioTooLong");
    } else if (personalBio.split(/\r?\n/).length > 8) {
      return t("profile.bioTooManyLines");
    }
    return null;
  })();
  const [profileFeedback, setProfileFeedback] = useState<SettingsFeedback | null>(null);

  // Password change modal states
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordModalFeedback, setPasswordModalFeedback] = useState<SettingsFeedback | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // localStorage is only available after mount, so this hydration must stay in
  // an effect; reading it during render would break SSR/hydration.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- post-mount localStorage hydration */
    const savedUser = localStorage.getItem("user");
    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser);
        setPersonalUsername(parsed.username || user.username);
        setPersonalEmail(parsed.email || user.email);
        setPersonalAvatar(parsed.avatar || user.avatar);
        setPersonalBio(parsed.bio || user.bio || "");
      } catch (error) {
        console.error(error);
      }
    } else {
      setPersonalUsername(user.username);
      setPersonalEmail(user.email);
      setPersonalAvatar(user.avatar);
      setPersonalBio(user.bio || "");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [user]);

  useEffect(() => {
    return () => {
      if (avatarPreviewUrl) {
        URL.revokeObjectURL(avatarPreviewUrl);
      }
    };
  }, [avatarPreviewUrl]);

  const hasUnsavedChanges = 
    personalUsername !== user.username ||
    personalEmail !== user.email ||
    personalBio !== (user.bio || "") ||
    personalAvatarFile !== null;

  const handleCancel = () => {
    setPersonalUsername(user.username);
    setPersonalEmail(user.email);
    setPersonalBio(user.bio || "");
    setPersonalAvatarFile(null);
    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl);
      setAvatarPreviewUrl(null);
    }
    setProfileFeedback(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const [shouldAlertEffect, setShouldAlertEffect] = useState(false);

  useEffect(() => {
    setHasUnsavedChanges(hasUnsavedChanges);
    return () => setHasUnsavedChanges(false);
  }, [hasUnsavedChanges, setHasUnsavedChanges]);

  useEffect(() => {
    const handleAlert = () => {
      setShouldAlertEffect(true);
      setTimeout(() => {
        setShouldAlertEffect(false);
      }, 1600);
    };
    window.addEventListener("trigger-unsaved-alert", handleAlert);
    return () => window.removeEventListener("trigger-unsaved-alert", handleAlert);
  }, []);

  const currentTheme = user.theme || "light";
  const currentLanguage = user.language || uiLanguage;
  const currentNotifyDesktop = user.notifyDesktop ?? true;
  const currentNotifySound = user.notifySound ?? true;

  const updatePreference = async (updates: Partial<PreferencesInput>) => {
    try {
      await handleUpdatePreferences({
        theme: updates.theme ?? currentTheme,
        language: updates.language ?? currentLanguage,
        notifyDesktop: updates.notifyDesktop ?? currentNotifyDesktop,
        notifySound: updates.notifySound ?? currentNotifySound,
      });
    } catch (error) {
      console.error("Failed to update preferences:", error);
    }
  };

  const handlePersonalAvatarChange = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      setProfileFeedback({ type: "error", text: t("avatarUpload.invalidType") });
      event.target.value = "";
      return;
    }

    if (file.size > AVATAR_UPLOAD_MAX_BYTES) {
      setProfileFeedback({ type: "error", text: t("avatarUpload.tooLarge") });
      event.target.value = "";
      return;
    }

    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl);
    }

    const previewUrl = URL.createObjectURL(file);
    setPersonalAvatarFile(file);
    setAvatarPreviewUrl(previewUrl);
    setProfileFeedback(null);
  };

  const handleProfileSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (bioError) return;
    setProfileFeedback(null);

    try {
      const updatedUser = await handleUpdateProfile({
        username: personalUsername,
        email: personalEmail,
        avatar: personalAvatar,
        avatarFile: personalAvatarFile,
        bio: personalBio,
      });
      setPersonalAvatar(updatedUser.avatar);
      if (avatarPreviewUrl) {
        URL.revokeObjectURL(avatarPreviewUrl);
      }
      setPersonalAvatarFile(null);
      setAvatarPreviewUrl(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setProfileFeedback({ type: "success", text: t("profile.profileSaved") });
    } catch (error) {
      console.error(error);
      setProfileFeedback({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to save profile.",
      });
    }
  };

  const handlePasswordSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordModalFeedback(null);

    if (!currentPassword) {
      setPasswordModalFeedback({ type: "error", text: t("profile.currentPasswordPlaceholder") });
      return;
    }

    if (newPassword.length < 8) {
      setPasswordModalFeedback({ type: "error", text: t("profile.passwordTooShort") });
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordModalFeedback({ type: "error", text: t("profile.passwordMismatch") });
      return;
    }

    setIsChangingPassword(true);
    try {
      await handleUpdateProfile({
        username: personalUsername || user.username,
        email: personalEmail || user.email,
        avatar: personalAvatar || user.avatar,
        bio: personalBio || user.bio || "",
        password: newPassword,
        currentPassword: currentPassword,
      });
      
      setPasswordModalFeedback({ type: "success", text: t("profile.passwordChangedSuccess") });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      
      setTimeout(() => {
        setIsPasswordModalOpen(false);
        setPasswordModalFeedback(null);
      }, 2000);
    } catch (error) {
      console.error(error);
      const msg = error instanceof Error ? error.message : "";
      const text =
        msg === "Incorrect current password" || msg === "目前密碼驗證失敗，請重新輸入。"
          ? t("profile.passwordChangedFailed")
          : msg || t("profile.passwordChangedFailed");
      setPasswordModalFeedback({
        type: "error",
        text,
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  return (
    <>
      <form onSubmit={handleProfileSubmit} className="flex flex-col gap-6 max-w-4xl">
        <FeedbackMessage feedback={profileFeedback} />
        <SectionTitle title={t("profile.profile")} />
        <div className="flex items-center gap-6 py-2">
          <Avatar name={personalUsername} src={avatarPreviewUrl ?? personalAvatar} size="lg" />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={handleAvatarFileChange}
          />
          <Button type="button" variant="secondary" onClick={handlePersonalAvatarChange}>
            {t("profile.changeAvatar")}
          </Button>
        </div>
        <div className="text-xs text-text-muted -mt-3">
          {t("avatarUpload.requirements")}
          {personalAvatarFile ? ` ${t("avatarUpload.selected", { name: personalAvatarFile.name })}` : ""}
        </div>
        <div className="flex flex-col gap-4">
          <Input label={t("profile.userId")} value={user.userId} readOnly disabled />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input 
              label={t("profile.username")} 
              value={personalUsername} 
              onChange={(event) => setPersonalUsername(event.target.value)} 
              onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
              required 
            />
            <Input 
              label={t("profile.email")} 
              type="email" 
              value={personalEmail} 
              onChange={(event) => setPersonalEmail(event.target.value)} 
              onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
              required 
            />
          </div>
          <Textarea 
            label={t("profile.bio")} 
            value={personalBio} 
            onChange={(event) => setPersonalBio(event.target.value)} 
            error={bioError || undefined}
          />
        </div>

        <div className={cn(
          "border-t border-border-primary py-3 flex items-center justify-end gap-3 transition-all duration-300",
          shouldAlertEffect && "animate-red-flash"
        )}>
          {hasUnsavedChanges && (
            <span className="text-xs text-amber-600 font-sans mr-2 select-none">
              ⚠️ {t("profile.unsavedChangesTip")}
            </span>
          )}
          <Button type="button" variant="secondary" onClick={handleCancel}>
            {t("profile.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!!bioError}>
            {t("profile.saveProfile")}
          </Button>
        </div>
      </form>

      <div className="max-w-4xl mt-10 pt-6 flex flex-col gap-4">
        <SectionTitle title={t("profile.security")} />
        <div className="flex flex-col gap-3 items-start">
          <p className="text-xs text-text-muted font-sans select-none">
            {t("profile.securityTip")}
          </p>
          <Button type="button" variant="secondary" onClick={() => setIsPasswordModalOpen(true)}>
            {t("profile.changePasswordButton")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-6 max-w-4xl mt-12">
        <SectionTitle title={t("profile.notifications")} />
        <div className="flex flex-col gap-3">
          <Checkbox 
            label={t("profile.desktopNotifications")} 
            checked={currentNotifyDesktop} 
            onChange={(event) => void updatePreference({ notifyDesktop: event.target.checked })} 
          />
          <Checkbox 
            label={t("profile.messageSounds")} 
            checked={currentNotifySound} 
            onChange={(event) => void updatePreference({ notifySound: event.target.checked })} 
          />
        </div>

        <SectionTitle title={t("profile.appearance")} />
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input 
              type="radio" 
              name="theme" 
              checked={currentTheme === "light"} 
              onChange={() => void updatePreference({ theme: "light" })} 
              className="accent-primary" 
            />
            {t("profile.light")}
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input 
              type="radio" 
              name="theme" 
              checked={currentTheme === "dark"} 
              onChange={() => void updatePreference({ theme: "dark" })} 
              className="accent-primary" 
            />
            {t("profile.dark")}
          </label>
        </div>

        <SectionTitle title={t("profile.language")} />
        <select
          value={currentLanguage}
          onChange={(event) => void updatePreference({ language: event.target.value as UiLanguage })}
          className="bg-surface-card border border-border-secondary hover:border-border-primary focus:border-primary focus:outline-none rounded-sm px-3 py-2.5 text-sm text-foreground transition-colors max-w-xs cursor-pointer"
        >
          <option value="zh-TW">繁體中文</option>
          <option value="en">English</option>
        </select>

        <SectionTitle title={t("profile.appInfo")} />
        <div className="text-sm text-foreground/70">
          {t("profile.version")}：v {process.env.NEXT_PUBLIC_APP_VERSION}
        </div>
      </div>


      <div className="mt-12 max-w-4xl border border-border-primary rounded-lg p-6 bg-surface-card">
        <h3 className="text-lg font-semibold text-foreground mb-2">{t("sidebar.logout")}</h3>
        <p className="text-sm text-foreground/70 mb-4">
          {t("profile.logoutWarning")}
        </p>
        <Button
          type="button"
          variant="secondary"
          className="bg-primary/10 text-primary hover:bg-primary hover:text-white border-primary/20 transition-colors"
          onClick={handleLogout}
        >
          {t("sidebar.logout")}
        </Button>
      </div>

      <div className="mt-12 max-w-4xl border border-red-500/20 rounded-lg p-6 bg-red-500/5">
        <h3 className="text-lg font-semibold text-red-500 mb-2">{t("profile.deleteAccount")}</h3>
        <p className="text-sm text-foreground/70 mb-4">
          {t("profile.deleteAccountWarning")}
        </p>
        <Button
          type="button"
          variant="secondary"
          className="bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white border-red-500/20 transition-colors"
          onClick={async () => {
            if (window.confirm(t("profile.deleteAccountConfirm"))) {
              try {
                await handleDeleteAccount();
              } catch {
                setProfileFeedback({ type: "error", text: t("profile.deleteAccountFailed") });
              }
            }
          }}
        >
          {t("profile.deleteAccountButton")}
        </Button>
      </div>

      <Modal
        isOpen={isPasswordModalOpen}
        onClose={() => {
          if (!isChangingPassword) {
            setIsPasswordModalOpen(false);
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setPasswordModalFeedback(null);
          }
        }}
        title={t("profile.changePasswordButton")}
      >
        <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
          <FeedbackMessage feedback={passwordModalFeedback} />
          
          <Input
            label={t("profile.currentPassword")}
            type="password"
            placeholder={t("profile.currentPasswordPlaceholder")}
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setPasswordModalFeedback(null);
            }}
            required
            disabled={isChangingPassword}
          />
          
          <Input
            label={t("profile.newPassword")}
            type="password"
            placeholder={t("profile.newPasswordPlaceholder")}
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setPasswordModalFeedback(null);
            }}
            required
            disabled={isChangingPassword}
          />
          
          <Input
            label={t("profile.confirmPassword")}
            type="password"
            placeholder={t("profile.confirmPasswordPlaceholder")}
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setPasswordModalFeedback(null);
            }}
            required
            disabled={isChangingPassword}
          />
          
          <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-border-primary">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setIsPasswordModalOpen(false);
                setCurrentPassword("");
                setNewPassword("");
                setConfirmPassword("");
                setPasswordModalFeedback(null);
              }}
              disabled={isChangingPassword}
            >
              {t("profile.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={isChangingPassword}
            >
              {isChangingPassword ? t("profile.changingPassword") : t("profile.changePasswordButton")}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
