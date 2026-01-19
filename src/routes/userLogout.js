import express from "express";
const router = express.Router();
// Logout route
router.post("/logout", async (req, res) => {
  try {
    const isProd = process.env.NODE_ENV === "production";
    await res.clearCookie("authToken", {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      path: "/",
      ...(process.env.COOKIE_DOMAIN
        ? { domain: process.env.COOKIE_DOMAIN }
        : {}),
    });
    res.status(200).json({ message: "Logout successful" });
  } catch (error) {
    console.error("Error during logout:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
