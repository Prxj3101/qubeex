import express from 'express';
import superadminRoutes from "./modules/superadmin/superadmin.routes";
import authRoutes from "./modules/auth/auth.routes";
import adminRoutes from "./modules/admin/admin.routes";

const app = express();

app.use(express.json());

app.use("/api/superadmin", superadminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);

app.get('/',(req,res) => {
    res.send("Server is running...");
});

export default app;